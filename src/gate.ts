import { DurableObject } from "cloudflare:workers";
import { type InstanceSize, type SetupSnapshot, WORKDIR, bootContainer, clip, gitWithToken, installToolchains, outOfMemory, run, takeGitRequests } from "./container";
import { describeCounts, type GitRequests, repoOfUrl } from "./git-http";
import { statusOf } from "./errors";
import { BOT } from "./git";
import { DEPENDENCIES, DEPENDENCY_FILES } from "./toolchains";
import { type MergeClaim, mergeMessage } from "./toolkit/merge-commit";
import { makeStamper } from "./toolkit/stamp";

// The project's checks, run before changes land: a batch of changes merged
// onto the project's branch, in order, and the checks run on the combined
// code, in a container. No model is involved.
//
// A change's Gate checks the batches that end in it (see toolkit/merge.ts).
// The repo's own Gate reads a batch's changes and lands them (inspectBatch,
// landBatch): it never runs a change's code, so it can be trusted with what a
// change touched and with the token that writes the project's branch. Each
// runs in a container started from the repo's snapshot: dependencies stay
// installed between runs, and an install is skipped while what it depends on
// is unchanged. Python, Go and Rust are installed when the repo uses them
// (see toolchains.ts), with their dependencies.

export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

export interface GateResult {
	passed: boolean;
	/** The commit that was checked. */
	head: string;
	/** The project's branch commit it was merged onto. */
	baseHead: string;
	/** Set when the change didn't merge cleanly. */
	mergeConflict?: string[];
	results: CheckResult[];
	at: string;
}

/** One check run: where the project's branch and the change are, and what runs. */
interface CheckPlan {
	/** The repo, for its snapshot (see snapshotFor). */
	repo?: string;
	baseHead: string;
	/** The project's branch (main, master, ...). */
	branch?: string;
	base: { remote: string; token: string };
	/** Where the change is: its branch in its author's fork. */
	fork: { remote: string; token: string; ref: string };
	/** The batch's other changes: merged in, in order, before the commit checked (see toolkit/merge.ts). */
	ahead?: { head: string; remote: string; token: string; ref?: string }[];
	checks: string[];
}

/** A check that installs dependencies (any of the usual package managers): what warming a container runs. */
const INSTALLS = /^(npm|pnpm|yarn)\s+(ci|install)(\s|$)/;

/**
 * A Node project's checks, with an install first when none of them installs
 * its dependencies: `npm ci` from an npm lockfile, `npm install` without one
 * (Express has none). Otherwise every check fails on missing tools.
 */
export function withInstall(checks: string[], project: { packageJson: boolean; npmLockfile: boolean }) {
	if (!project.packageJson || checks.some((c) => INSTALLS.test(c.trim()))) return checks;
	return [project.npmLockfile ? "npm ci" : "npm install", ...checks];
}
/** How long a container stays up after its last run: long enough for a check that follows at once (a merge checking again, say). */
export const GRACE_MS = 60_000;
/** How long the repo's own Gate keeps a batch it read fetched, for its landing after the batch's checks. */
const BATCH_HOLD_MS = 5 * 60_000;
/** How often a batch's push is tried while the repo is busy with another, and the first wait (each after is longer). */
const PUSH_TRIES = 8;
const PUSH_RETRY_MS = 1_500;

/** Whether a push was refused only because the repo was taking another one. */
export const pushBusy = (output: string) => /receive_pack_busy|repository is busy|try again later/i.test(output);

/**
 * How many of a batch's forks are fetched at once: each from its own fork, so
 * no one repo is busier. 8 at a time, a batch of 64 took 84 to 95 s to read.
 */
const FETCHES_AT_ONCE = 16;
/** The platform stops a container left this long, in case GitHive's own stop never comes. */
const SAFETY_MS = 30 * 60_000;
/** A container warmed this recently isn't warmed again. */
const WARM_FOR_MS = 60_000;
/** A repo's snapshot is taken again this often, so containers from it have little of main to fetch, and Containers' 30 days never run out. */
const SNAPSHOT_RETAKE_MS = 7 * 24 * 3600_000;
/** A snapshot older than this may be gone (Containers keeps one 30 days after it was taken or last restored): not started from. */
const SNAPSHOT_USABLE_MS = 25 * 24 * 3600_000;

/** Whether a new snapshot is due: none yet, its dependencies differ from the ones installed now, or it's a week old. */
export function snapshotDue(current: SetupSnapshot | null, installed: { lockHash?: string; depsHash?: string }, now = Date.now()) {
	return !current || current.lockHash !== installed.lockHash || current.depsHash !== installed.depsHash || now - current.at >= SNAPSHOT_RETAKE_MS;
}

/** A check container's size: small at first, larger once a repo's checks run out of memory in it (see check). */
const SMALL: InstanceSize = "small";
const LARGE: InstanceSize = "large";
/** How long one check command may run. */
const CHECK_TIMEOUT_S = 600;

/** What a warm-up on main needs: the repo, its branch, read access, and the checks (for their install step). */
export interface WarmUp {
	repo: string;
	branch?: string;
	base: { remote: string; token: string };
	checks: string[];
}

/** A change of a batch, and where its branch lives: a fork, and the token to read it. */
export interface BatchSource {
	change: string;
	remote: string;
	token: string;
	ref: string;
}

/** A merge's checks: the project's branch and checks, and the change's fork and commit. */
export interface ChangeCheck {
	/** The repo, for its snapshot (see snapshotFor). */
	repo?: string;
	branch?: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string; ref: string };
	head: string;
	checks: string[];
}

export class Gate extends DurableObject<Env> {
	/** Checks run one at a time: there is one container, and one checkout in it. */
	private checking: Promise<unknown> = Promise.resolve();
	/** Checks and warm-ups running or waiting their turn: while any is, the container stays up. */
	private active = 0;

	/**
	 * Run `work` in turn with the container's other work, keeping the container
	 * up meanwhile, and after it. What it asked of Git servers is logged after
	 * it, as `what` for `repo` (see logGitRequests).
	 */
	private inTurn<T>(what: string, repo: string | undefined, work: () => Promise<T>): Promise<T> {
		this.active++;
		const run = this.checking.then(work).finally(async () => {
			await this.logGitRequests(what, repo).catch(() => undefined);
			this.active--;
			await this.ctx.storage.put("lastActive", Date.now());
			await this.scheduleStop();
		});
		this.checking = run.catch(() => {});
		return run;
	}

	/**
	 * Check one commit now: merge `head` onto `baseHead` (after the batch's
	 * other changes, `ahead`) and run `checks`, returning the result. The
	 * Gate of a batch's last change (repo:<repo>:change:<change>) runs them.
	 */
	checkCommit(input: ChangeCheck & { baseHead: string; ahead?: CheckPlan["ahead"] }): Promise<GateResult> {
		const plan: CheckPlan = { ...(input.repo ? { repo: input.repo } : {}), baseHead: input.baseHead, branch: input.branch, base: input.base, fork: input.fork, ...(input.ahead?.length ? { ahead: input.ahead } : {}), checks: input.checks };
		return this.inTurn("check", input.repo, async () => {
			try {
				return await this.check(input.head, plan);
			} catch (err) {
				await this.ctx.storage.delete("prepared");
				return { passed: false, head: input.head, baseHead: input.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: statusOf(err).message }], at: new Date().toISOString() } satisfies GateResult;
			}
		});
	}

	/**
	 * Read a batch's changes, in this, the repo's own Gate: each change's head
	 * now (its branch's tip) and the files it changed since it left
	 * `baseHead`, or why it couldn't be read. Never in a change's Gate: one
	 * that ran a change's code can't be trusted to say what a change touched.
	 */
	inspectBatch(input: { repo: string; branch: string; base: { remote: string; token: string }; baseHead: string; changes: BatchSource[] }): Promise<({ change: string; head: string; files: string[] } | { change: string; error: string })[]> {
		return this.inTurn("inspectBatch", input.repo, async () => {
			const container = this.landingContainer(input.repo);
			await this.fetchBatch(container, input);
			const failed = await this.fetchChanges(container, input.changes.map((c, k) => ({ k, ...c })));
			// Each change's head, then the files it changed since it left main, NUL-separated (any name survives); one command for all.
			const fetched = input.changes.map((_, k) => k).filter((k) => !failed.has(k));
			const script = fetched
				.map((k) => `if h=$(git rev-parse refs/remotes/batch-${k}/head) && b=$(git merge-base ${input.baseHead} "$h"); then printf '%s %s\\0' ${k} "$h"; git diff --name-only --no-renames -z "$b" "$h"; else printf '%s -\\0' ${k}; fi; printf '\\0'`)
				.join("\n");
			const listed = new Map<number, { head: string; files: string[] }>();
			if (fetched.length) {
				const r = await run(container, ["bash", "-c", script]);
				for (const record of r.output.split("\0\0").filter(Boolean)) {
					const [first, ...files] = record.split("\0");
					const [k, head] = first.split(" ");
					if (head && head !== "-") listed.set(Number(k), { head, files: files.filter(Boolean) });
				}
			}
			// The repo's own Gate keeps them fetched for the batch's landing, after its checks.
			await this.ctx.storage.put("holdUntil", Date.now() + BATCH_HOLD_MS);
			return input.changes.map((c, k) => {
				const read = listed.get(k);
				if (read) return { change: c.change, ...read };
				return { change: c.change, error: failed.has(k) ? `fetch of its branch failed: ${failed.get(k)}` : "its branch couldn't be read" };
			});
		});
	}

	/**
	 * Land a batch, in this, the repo's own Gate: each change merged onto
	 * `baseHead` in order as its own merge commit (its trailers from `claimed`,
	 * its base the commit before it, stamped by GitHive as `by`), then pushed
	 * to the branch in one push, so the branch is never partway through a
	 * batch. "moved" if the branch isn't at `baseHead` any more.
	 */
	landBatch(input: { repo: string; branch: string; base: { remote: string; token: string }; baseHead: string; merges: (BatchSource & { head: string; claimed: Omit<MergeClaim, "base"> })[]; by?: string }): Promise<{ commits: string[] } | { moved: true } | { error: string }> {
		return this.inTurn("landBatch", input.repo, async () => {
			const container = this.landingContainer(input.repo);
			await this.fetchBatch(container, input);
			// Read for this batch, they're here already (see inspectBatch): only what's missing is fetched.
			const missing = await run(container, ["bash", "-c", input.merges.map((m, k) => `git cat-file -e ${m.head}^{commit} 2>/dev/null || echo ${k}`).join("\n")]);
			const fetch = missing.output.split("\n").filter(Boolean).map(Number);
			const failed = await this.fetchChanges(container, fetch.map((k) => ({ k, ...input.merges[k] })));
			for (const [k, why] of failed) return { error: `fetch of ${input.merges[k].change} failed: ${why}` };
			const absent = await run(container, ["bash", "-c", input.merges.map((m) => `git cat-file -e ${m.head}^{commit} 2>/dev/null || echo ${m.change}`).join("\n")]);
			if (absent.output.trim()) return { error: `not on their branches: ${absent.output.trim().split("\n").join(", ")}` };
			await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${input.baseHead} && git clean -fdq`]);
			const stamper = this.env.STAMP_KEY && input.by ? await makeStamper(this.env.STAMP_KEY, input.by) : undefined;
			const as = ["-c", `user.name=${BOT.name}`, "-c", `user.email=${BOT.email}`];
			for (const m of input.merges) {
				// The commit before it (its merge's base), then the merge itself, uncommitted: one command.
				const merged = await run(container, ["bash", "-c", `base=$(git rev-parse HEAD) && git merge -q --no-ff --no-commit ${m.head} >/tmp/merge.out 2>&1 && echo "$base" || { echo CONFLICT; git diff --name-only --diff-filter=U; cat /tmp/merge.out; git merge --abort; exit 1; }`]);
				const base = merged.output.trim();
				if (merged.exitCode !== 0) return { error: `merging ${m.change} onto the batch failed: ${clip(merged.output.replace(/^CONFLICT\n/, ""), 500)}` };
				// Always a merge commit, never a fast-forward: the merge's trailers are what the audit reads.
				const committed = await run(container, ["git", ...as, "commit", "-q", "--no-verify", "-F", "-"], WORKDIR, await mergeMessage({ ...m.claimed, base }, stamper));
				if (committed.exitCode !== 0) return { error: `committing ${m.change}'s merge failed: ${clip(committed.output, 500)}` };
			}
			const commits = (await run(container, ["git", "rev-list", "--reverse", "--first-parent", `${input.baseHead}..HEAD`])).output.split("\n").filter(Boolean);
			// Pushed only if the branch is still exactly at the base. A plain push isn't enough: it only refuses a push that
			// isn't a fast-forward, and a change branched from a newer main would make this one a fast-forward of it.
			// A repo takes one push at a time: busy with another (a crowd's records, say), Artifacts refuses this one, which
			// lost two batches in a row at 200 agents. Tried again, waiting longer each time, up to about 100 s in all.
			let pushed = await gitWithToken(container, input.base.token, ["push", "-q", `--force-with-lease=refs/heads/${input.branch}:${input.baseHead}`, input.base.remote, `HEAD:refs/heads/${input.branch}`]);
			for (let attempt = 1; pushed.exitCode !== 0 && pushBusy(pushed.output) && attempt < PUSH_TRIES; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, PUSH_RETRY_MS * 1.6 ** attempt * (0.75 + Math.random() / 2)));
				pushed = await gitWithToken(container, input.base.token, ["push", "-q", `--force-with-lease=refs/heads/${input.branch}:${input.baseHead}`, input.base.remote, `HEAD:refs/heads/${input.branch}`]);
			}
			if (pushed.exitCode !== 0) return /rejected|non-fast-forward|fetch first|stale info/i.test(pushed.output) ? { moved: true } : { error: `the push failed: ${clip(pushed.output, 500)}` };
			await this.ctx.storage.delete("holdUntil");
			return { commits };
		});
	}

	/**
	 * A batch merged onto `baseHead` as it will land, each change its own merge,
	 * pushed to `ref` on `to` (a connected GitHub repo, whose Actions check it):
	 * in this, the repo's own Gate, with real git, never in a Worker's memory.
	 * Its tip, or why it couldn't be made or pushed.
	 */
	checksBranch(input: { repo: string; branch: string; base: { remote: string; token: string }; baseHead: string; changes: { change: string; remote: string; token: string; ref: string; head: string }[]; to: { remote: string; token: string; user?: string }; ref: string }): Promise<{ tip: string } | { failed: string }> {
		return this.inTurn("checksBranch", input.repo, async () => {
			const container = this.landingContainer(input.repo);
			await this.fetchBatch(container, input);
			const missing = await run(container, ["bash", "-c", input.changes.map((c, k) => `git cat-file -e ${c.head}^{commit} 2>/dev/null || echo ${k}`).join("\n")]);
			const fetch = missing.output.split("\n").filter(Boolean).map(Number);
			const failed = await this.fetchChanges(container, fetch.map((k) => ({ k, ...input.changes[k] })));
			for (const [k, why] of failed) return { failed: `fetch of ${input.changes[k].change} failed: ${why}` };
			await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${input.baseHead} && git clean -fdq`]);
			for (const c of input.changes) {
				const merged = await run(container, ["bash", "-c", `git merge -q --no-ff -m "Check ${c.change} with the batch" ${c.head} >/tmp/merge.out 2>&1 || { git diff --name-only --diff-filter=U; cat /tmp/merge.out; git merge --abort; exit 1; }`]);
				if (merged.exitCode !== 0) return { failed: `${c.change} doesn't merge onto the batch: ${clip(merged.output, 500)}` };
			}
			const tip = (await run(container, ["git", "rev-parse", "HEAD"])).output.trim();
			const pushed = await gitWithToken(container, input.to.token, ["push", "-q", "--force", input.to.remote, `HEAD:refs/heads/${input.ref}`], WORKDIR, input.to.user);
			if (pushed.exitCode !== 0) return { failed: `the push to ${input.ref} failed: ${clip(pushed.output, 500)}` };
			return { tip };
		});
	}

	/**
	 * Push `branch` at `head` to `to` (a connected GitHub repo, its copy kept
	 * up to date after every landing) as a fast-forward only: what someone
	 * pushed there directly is never overwritten. In this, the repo's own Gate.
	 */
	pushBranch(input: { repo: string; branch: string; base: { remote: string; token: string }; head: string; to: { remote: string; token: string; user?: string } }): Promise<{ pushed: true } | { refused: string }> {
		return this.inTurn("pushBranch", input.repo, async () => {
			const container = this.landingContainer(input.repo);
			await this.fetchBatch(container, { ...input, baseHead: input.head });
			const pushed = await gitWithToken(container, input.to.token, ["push", "-q", input.to.remote, `${input.head}:refs/heads/${input.branch}`], WORKDIR, input.to.user);
			return pushed.exitCode === 0 ? { pushed: true } : { refused: clip(pushed.output, 500) };
		});
	}

	/** The container a batch is read and landed in: this Gate's, which must be the repo's own. */
	private landingContainer(repo: string) {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for Gate");
		if (!this.ownsSnapshot(repo)) throw new Error("only the repo's own Gate reads and lands batches: a change's Gate runs that change's code");
		return container;
	}

	/** Ready to read or land a batch on `baseHead`: running, the branch fetched, and no hook (none is ever written here) can run. */
	private async fetchBatch(container: Container, input: { repo: string; branch: string; base: { remote: string; token: string }; baseHead: string }) {
		await this.prepare(container, input.base, input.repo);
		// No hook can run (none is ever written here), and every merge and commit is GitHive's: a container has no git identity of its own.
		await run(container, ["bash", "-c", `git config core.hooksPath /dev/null && git config user.name "${BOT.name}" && git config user.email "${BOT.email}"`]);
		const fetched = await gitWithToken(container, input.base.token, ["fetch", "-q", input.base.remote, `${input.branch}:refs/remotes/base/${input.branch}`, "--force"]);
		if (fetched.exitCode !== 0) throw new Error(`fetch of the project's ${input.branch} failed: ${clip(fetched.output, 2_000)}`);
		if ((await run(container, ["git", "cat-file", "-e", `${input.baseHead}^{commit}`])).exitCode !== 0) throw new Error(`${input.branch} at ${input.baseHead} isn't in the project`);
	}


	/**
	 * Fetch each change's branch into refs/remotes/batch-<k>/head, a few at a
	 * time, each tried three times: one command for them all. Returns the ones
	 * that failed, and why. The tokens go in on stdin, not on the command line.
	 */
	private async fetchChanges(container: Container, changes: { k: number; remote: string; token: string; ref: string }[]): Promise<Map<number, string>> {
		if (!changes.length) return new Map();
		const script = [
			"fetch_one() {",
			'  for try in 1 2 3; do',
			'    if out=$(git -c gc.auto=0 -c "http.extraHeader=Authorization: Bearer $4" fetch -q --no-write-fetch-head "$2" "$3:refs/remotes/batch-$1/head" --force 2>&1); then return 0; fi',
			"    sleep $((try * 2))",
			"  done",
			'  printf "%s %s\\n" "$1" "$(printf %s "$out" | tr "\\n" " " | cut -c1-300)" > "/tmp/batch-failed-$1"',
			"}",
			"rm -f /tmp/batch-failed-*",
			"while IFS=$'\\t' read -r k remote ref token; do",
			'  fetch_one "$k" "$remote" "$ref" "$token" &',
			`  while [ "$(jobs -rp | wc -l)" -ge ${FETCHES_AT_ONCE} ]; do wait -n; done`,
			"done",
			"wait",
			"cat /tmp/batch-failed-* 2>/dev/null; rm -f /tmp/batch-failed-*; true",
		].join("\n");
		const stdin = changes.map((c) => [c.k, c.remote, c.ref, c.token.split("?expires=")[0]].join("\t")).join("\n") + "\n";
		const r = await run(container, ["bash", "-c", script], WORKDIR, stdin);
		const failed = new Map<number, string>();
		for (const line of r.output.split("\n").filter(Boolean)) {
			const space = line.indexOf(" ");
			const k = Number(line.slice(0, space));
			if (Number.isInteger(k)) failed.set(k, line.slice(space + 1));
		}
		if (r.exitCode !== 0 && !failed.size) for (const c of changes) failed.set(c.k, clip(r.output, 300));
		return failed;
	}

	/**
	 * Start this Gate's container for checks about to come: a batch's first
	 * check, while the batch is read, so the check finds it running. In turn
	 * with the checks, so one that arrives meanwhile waits for it.
	 */
	boot(input: { repo: string; base: { remote: string; token: string } }): Promise<void> {
		return this.inTurn("boot", input.repo, async () => {
			const container = this.ctx.container;
			if (container) await this.prepare(container, input.base, input.repo);
		});
	}

	/**
	 * Log the Git requests this container made for `what` (one unit of work:
	 * a check, a batch read or landed, a warm-up), by kind of repo, from git's
	 * trace (see takeGitRequests): "gate landBatch on <repo> git: project 2, forks 5".
	 */
	private async logGitRequests(what: string, repo: string | undefined) {
		const container = this.ctx.container;
		if (!container?.running) return;
		const taken = await takeGitRequests(container);
		if (!taken?.paths.size) return;
		const requests: GitRequests = new Map();
		for (const [path, n] of taken.paths) {
			const name = repoOfUrl(`https://git${path}`);
			const seen = requests.get(name) ?? { requests: 0, failed: 0 };
			requests.set(name, { requests: seen.requests + n, failed: 0 });
		}
		console.log(`gate ${what} on ${repo ?? "-"} ${describeCounts(repo ?? "", requests, new Map())}${taken.failed ? ` (${taken.failed} failed)` : ""}`);
	}

	/** Make sure an alarm comes by `at` (an earlier one stays). */
	private async alarmBy(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	/** Plan the container's stop: an alarm a grace after its last run; none while it isn't running. */
	private async scheduleStop() {
		if (!this.ctx.container?.running) return;
		await this.alarmBy(Math.max(((await this.ctx.storage.get<number>("lastActive")) ?? Date.now()) + GRACE_MS, (await this.ctx.storage.get<number>("holdUntil")) ?? 0));
	}

	async alarm() {
		// A warm-up asked for (see warmUp).
		const warmUp = await this.ctx.storage.get<WarmUp>("warmUp");
		if (warmUp) {
			await this.ctx.storage.delete("warmUp");
			await this.warm(warmUp).catch(() => undefined);
		}
		await this.stopIfIdle();
	}

	/**
	 * Stop the container once nothing needs it: no check or warm-up running or
	 * waiting, and a grace since its last run. Otherwise look again when it
	 * might be.
	 */
	private async stopIfIdle() {
		const container = this.ctx.container;
		if (!container?.running) return;
		if (this.active > 0) return this.alarmBy(Date.now() + GRACE_MS);
		// A batch read and not landed yet keeps it up a while longer: its landing finds the changes already fetched.
		const at = Math.max(((await this.ctx.storage.get<number>("lastActive")) ?? 0) + GRACE_MS, (await this.ctx.storage.get<number>("holdUntil")) ?? 0);
		if (at > Date.now()) return this.alarmBy(at);
		await container.destroy("nothing to check");
		const started = await this.ctx.storage.get<{ at: number; repo: string | null; own: boolean; size: InstanceSize }>("started");
		if (started) console.log(JSON.stringify({ event: "check container stopped", repo: started.repo, gate: started.own ? "repo" : "change", size: started.size, seconds: Math.round((Date.now() - started.at) / 1000) }));
		await this.ctx.storage.delete(["prepared", "started", "holdUntil"]);
	}

	private async check(head: string, plan: CheckPlan): Promise<GateResult> {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for Gate");
		const result = (partial: Partial<GateResult>): GateResult => ({
			passed: false,
			head,
			baseHead: plan.baseHead,
			results: [],
			at: new Date().toISOString(),
			...partial,
		});

		const started = await this.prepare(container, plan.base, plan.repo);

		const branch = plan.branch ?? "main";
		const base = await gitWithToken(container, plan.base.token, ["fetch", "-q", plan.base.remote, `${branch}:refs/remotes/base/${branch}`, "--force"]);
		if (base.exitCode !== 0) throw new Error(`fetch of the project's ${branch} failed: ${clip(base.output, 2_000)}`);
		// The batch's changes, its others and then the change, fetched at once (one at a time, they were most of a big
		// batch's check). Branches, not bare commits (fetching a hash depends on server settings): each approved commit
		// is in its branch's history.
		// A container a batch's search reuses has most of them already: only what's missing is fetched.
		const sources = [...(plan.ahead ?? []).map((a) => ({ remote: a.remote, token: a.token, ref: a.ref ?? branch })), plan.fork];
		const commits = [...(plan.ahead ?? []).map((a) => a.head), head];
		const absent = async () => (await run(container, ["bash", "-c", commits.map((c, k) => `git cat-file -e ${c}^{commit} 2>/dev/null || echo ${k}`).join("\n")])).output.split("\n").filter(Boolean).map(Number);
		const failed = await this.fetchChanges(container, (await absent()).map((k) => ({ k, ...sources[k] })));
		for (const [k, why] of failed) throw new Error(`fetch of ${k === sources.length - 1 ? "the change" : "a change in the batch"} failed: ${why}`);
		const missing = await absent();
		if (missing.length) throw new Error(`approved commits not on their branches: ${missing.map((k) => commits[k]).join(", ")}`);

		// A clean checkout of the base; ignored files (node_modules) survive `git clean -fd`.
		await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${plan.baseHead} && git clean -fdq`]);
		// Merge the batch's other changes, in order, then the last, onto the base.
		for (const commit of [...(plan.ahead ?? []).map((a) => a.head), head]) {
			const merge = await run(container, ["git", "-c", "user.name=gate", "-c", "user.email=gate@githive.invalid", "merge", "-q", "--no-edit", commit]);
			if (merge.exitCode !== 0) {
				const conflicts = await run(container, ["git", "diff", "--name-only", "--diff-filter=U"]);
				await run(container, ["git", "merge", "--abort"]);
				return result({ mergeConflict: conflicts.output.split("\n").filter(Boolean) });
			}
		}

		// From here the change's own code runs (installers, scripts, tests): a container that ran one is never saved as the repo's snapshot.
		await this.ctx.storage.put("tainted", true);
		// Checks run on a fresh checkout: a Node project's dependencies are installed first.
		const checks = await this.checksFor(container, plan.checks);

		// Toolchains beyond Node, read from the merged code (a change may add one), and their dependencies.
		const setup = await this.setUpToolchains(container);
		if (setup.some((r) => r.exitCode !== 0)) return result({ results: setup });

		const results: CheckResult[] = [];
		for (const command of checks) {
			if (INSTALLS.test(command.trim()) && (await this.installUnchanged(container))) {
				results.push({ command, exitCode: 0, output: "Skipped: package.json and its lockfile are unchanged since the last install in this gate." });
				continue;
			}
			const started = Date.now();
			const r = await run(container, ["bash", "-lc", command], WORKDIR, undefined, CHECK_TIMEOUT_S);
			if (outOfMemory(r.exitCode, Date.now() - started, CHECK_TIMEOUT_S) && (await this.size()) !== LARGE) {
				// Killed for memory, not time: this repo's checks need the larger container. Move up and check again.
				console.log(`checks ran out of memory in a ${SMALL} container: moving up to ${LARGE}`);
				await this.ctx.storage.put("instance", LARGE);
				await container.destroy(`checks ran out of memory in ${SMALL}`);
				await this.ctx.storage.delete(["prepared", "lockHash", "depsHash"]);
				return this.check(head, plan);
			}
			results.push({ command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
			if (INSTALLS.test(command.trim())) await this.ctx.storage.put("lockHash", await this.lockHash(container));
		}
		// Set up from scratch, or installed what the snapshot didn't have: the repo's own Gate saves a fresh one, if main's setup changed.
		const installed = results.some((r) => INSTALLS.test(r.command.trim()) && !r.output.startsWith("Skipped"));
		if (plan.repo && !this.ownsSnapshot(plan.repo) && (started === "fresh" || installed))
			void this.env.GATE.getByName(`repo:${plan.repo}`)
				.warmUp({ repo: plan.repo, ...(plan.branch ? { branch: plan.branch } : {}), base: plan.base, checks: plan.checks })
				.catch(() => undefined);
		return result({ passed: results.length === checks.length && results.every((r) => r.exitCode === 0), results: [...setup, ...results] });
	}

	/**
	 * Install the toolchains the checkout uses and their dependencies, skipping
	 * the dependencies while the files they come from are unchanged. A failed
	 * install comes back as a failed check result.
	 */
	private async setUpToolchains(container: Container): Promise<CheckResult[]> {
		const installed = await installToolchains(container);
		const failed = installed.filter((i) => i.exitCode !== 0);
		if (failed.length) return failed.map((i) => ({ command: `install ${i.toolchain}`, exitCode: i.exitCode, output: clip(i.output, 6_000) }));
		if (!installed.length) return [];
		const hash = (await run(container, ["bash", "-c", `{ echo ${installed.map((i) => i.toolchain).join(",")}; cat ${DEPENDENCY_FILES} 2>/dev/null; } | sha256sum | cut -d' ' -f1`])).output.trim();
		if (hash && (await this.ctx.storage.get<string>("depsHash")) === hash)
			return installed.map((i) => ({ command: DEPENDENCIES[i.toolchain].command, exitCode: 0, output: "Skipped: the files dependencies come from are unchanged since the last install in this gate." }));
		const results: CheckResult[] = [];
		for (const { toolchain } of installed) {
			const r = await run(container, ["bash", "-lc", DEPENDENCIES[toolchain].script], WORKDIR, undefined, 600);
			results.push({ command: DEPENDENCIES[toolchain].command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) return results;
		}
		await this.ctx.storage.put("depsHash", hash);
		return results;
	}

	/**
	 * A running container with the project checked out: reused (with its
	 * installed dependencies) while it lives, and started from the repo's
	 * snapshot when there is one, so it fetches and installs only what
	 * changed since.
	 */
	private async prepare(container: Container, base: { remote: string; token: string }, repo?: string): Promise<"ready" | "restored" | "fresh"> {
		let started: "ready" | "restored" | "fresh" = "ready";
		if (!container.running || !(await this.ctx.storage.get<boolean>("prepared"))) {
			const snapshot = repo ? await this.snapshotFor(repo) : null;
			const size = await this.size();
			const booted = await bootContainer(container, size, snapshot);
			// For the log line when it stops: how long it ran, for whom, at what size (what it cost).
			if (booted !== "running") await this.ctx.storage.put("started", { at: Date.now(), repo: repo ?? null, own: !!repo && this.ownsSnapshot(repo), size });
			started = booted === "restored" && snapshot ? "restored" : "fresh";
			if (booted === "restored" && snapshot) {
				await this.ctx.storage.delete(["lockHash", "depsHash", "tainted"]);
				await this.ctx.storage.put({ ...(snapshot.lockHash ? { lockHash: snapshot.lockHash } : {}), ...(snapshot.depsHash ? { depsHash: snapshot.depsHash } : {}) });
				console.log(`gate container started at ${size} from ${repo}'s snapshot`);
			} else {
				if (snapshot && repo) await this.snapshotUnusable(repo, snapshot.id);
				const limits = await run(container, ["bash", "-c", "echo $(nproc) cpus, $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo) MiB"], "/");
				console.log(`gate container started at ${size}: ${limits.output.trim()}`);
				await run(container, ["rm", "-rf", WORKDIR], "/");
				const clone = await gitWithToken(container, base.token, ["clone", "--quiet", base.remote, WORKDIR], "/");
				if (clone.exitCode !== 0) throw new Error(`clone of the project failed: ${clip(clone.output, 2_000)}`);
				await this.ctx.storage.delete(["lockHash", "depsHash"]);
				// A container that was already running may have run a change's code; a fresh one hasn't.
				if (booted === "fresh") await this.ctx.storage.delete("tainted");
				else await this.ctx.storage.put("tainted", true);
			}
			await this.ctx.storage.put("prepared", true);
		}
		// GitHive stops it itself once nothing needs it (see stopIfIdle); this is the backstop.
		await container.setInactivityTimeout(SAFETY_MS);
		return started;
	}

	/** Whether this Gate is the repo's own (its first lane), which keeps the repo's snapshot. */
	private ownsSnapshot(repo: string) {
		const own = this.env.GATE?.idFromName?.(`repo:${repo}`);
		return !!own && !!this.ctx.id?.equals?.(own);
	}

	/** The repo's snapshot to start from, if it has a usable one: this Gate's own, or its first lane's. */
	private async snapshotFor(repo: string): Promise<SetupSnapshot | null> {
		if (this.ownsSnapshot(repo)) return this.snapshot();
		return this.env.GATE.getByName(`repo:${repo}`).snapshot().catch(() => null);
	}

	/** A snapshot that wouldn't start: forget it, so the next warm-up on main takes a new one. */
	private async snapshotUnusable(repo: string, id: string) {
		if (this.ownsSnapshot(repo)) return this.forgetSnapshot(id);
		await this.env.GATE.getByName(`repo:${repo}`).forgetSnapshot(id).catch(() => undefined);
	}

	/**
	 * The repo's snapshot, for its lanes, reviewers and builders to start
	 * from: null if none, or if it's too old to be sure it still exists
	 * (Containers keeps one 30 days after it was taken or last restored).
	 */
	async snapshot(): Promise<SetupSnapshot | null> {
		const snapshot = await this.ctx.storage.get<SetupSnapshot>("snapshot");
		return snapshot && Date.now() - snapshot.at < SNAPSHOT_USABLE_MS ? snapshot : null;
	}

	/** Forget the repo's snapshot (only `id`, if given: a newer one stays). Nothing starts from it again; Containers drops it within 30 days. */
	async forgetSnapshot(id?: string) {
		const snapshot = await this.ctx.storage.get<SetupSnapshot>("snapshot");
		if (snapshot && (!id || snapshot.id === id)) await this.ctx.storage.delete("snapshot");
	}

	/**
	 * Save this container as the repo's snapshot, when it's due (see
	 * snapshotDue) and the container is one to trust: started fresh or from
	 * the snapshot, and since then only set up on main (never a change's
	 * code, see check). Taking one is a head start for later containers,
	 * never a requirement: a failure is only logged.
	 */
	private async snapshotIfDue(container: Container, repo?: string) {
		if (!repo || !this.ownsSnapshot(repo) || (await this.ctx.storage.get<boolean>("tainted"))) return;
		const [current, lockHash, depsHash] = await Promise.all([this.ctx.storage.get<SetupSnapshot>("snapshot"), this.ctx.storage.get<string>("lockHash"), this.ctx.storage.get<string>("depsHash")]);
		if (!snapshotDue(current ?? null, { lockHash, depsHash })) return;
		try {
			const started = Date.now();
			const taken = await container.snapshotContainer({ name: `githive-${repo}`.slice(0, 64) });
			await this.ctx.storage.put("snapshot", { id: taken.id, size: taken.size, at: Date.now(), ...(lockHash ? { lockHash } : {}), ...(depsHash ? { depsHash } : {}) } satisfies SetupSnapshot);
			console.log(`saved ${repo}'s snapshot (${Math.round(taken.size / 1e6)} MB) in ${Date.now() - started} ms`);
		} catch (err) {
			console.error(`saving ${repo}'s snapshot failed`, statusOf(err).message);
		}
	}

	/**
	 * Warm this container for a repo's checks before a merge
	 * needs them: running, the project's branch checked out, and its install
	 * step run once, so the merge's checks start from installed dependencies.
	 * In turn with checks (one checkout); skipped if warmed in the last minutes.
	 */
	warm(input: Partial<Pick<WarmUp, "repo">> & Omit<WarmUp, "repo">): Promise<void> {
		return this.inTurn("warm", input.repo, async () => {
			const container = this.ctx.container;
			if (!container) return;
			const at = await this.ctx.storage.get<number>("warmedAt");
			if (container.running && at && Date.now() - at < WARM_FOR_MS) return;
			await this.ctx.storage.put("warmingSince", Date.now());
			try {
				await this.prepare(container, input.base, input.repo);
				const branch = input.branch ?? "main";
				const fetched = await gitWithToken(container, input.base.token, ["fetch", "-q", input.base.remote, `${branch}:refs/remotes/base/${branch}`, "--force"]);
				if (fetched.exitCode !== 0) return;
				// No checks: warm only to land batches, the project cloned and its branch fetched, and saved as the repo's
				// snapshot (with nothing installed), so a cold Gate restores it in seconds. Without one, the first batch of 200
				// agents' runs read 3 or 4 changes in 42 to 61 s, behind the container starting and Express cloning.
				if (!input.checks.length) {
					await this.ctx.storage.put("warmedAt", Date.now());
					await this.snapshotIfDue(container, input.repo);
					return;
				}
				await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach refs/remotes/base/${branch} && git clean -fdq`]);
				await this.setUpToolchains(container);
				const install = (await this.checksFor(container, input.checks)).find((c) => INSTALLS.test(c.trim()));
				if (install && !(await this.installUnchanged(container))) {
					const installed = await run(container, ["bash", "-lc", install], WORKDIR, undefined, 600);
					if (installed.exitCode === 0) await this.ctx.storage.put("lockHash", await this.lockHash(container));
				}
				await this.ctx.storage.put("warmedAt", Date.now());
				// Set up on main and nothing else: what later containers can start from.
				await this.snapshotIfDue(container, input.repo);
			} catch (err) {
				// Warming is a head start, never a requirement: the check prepares what it needs.
				console.error("warming a gate container failed", statusOf(err).message);
				await this.ctx.storage.delete(["prepared", "warmingSince"]);
			}
		});
	}

	/** The size this Gate's container starts at: small, until its checks have run out of memory. */
	private async size(): Promise<InstanceSize> {
		return (await this.ctx.storage.get<InstanceSize>("instance")) ?? SMALL;
	}

	/** This container's warmth: whether it runs, at what size, when it last finished warming, and whether it's warming now. */
	async warmth() {
		const [warmedAt, warmingSince, size] = await Promise.all([this.ctx.storage.get<number>("warmedAt"), this.ctx.storage.get<number>("warmingSince"), this.size()]);
		return {
			running: !!this.ctx.container?.running,
			size,
			warmedAt: warmedAt ?? null,
			warming: !!warmingSince && (!warmedAt || warmingSince > warmedAt),
		};
	}

	/** The repo's snapshot, for the dashboard: when it was taken and its size, or null. */
	async snapshotInfo() {
		const snapshot = await this.snapshot();
		return snapshot ? { at: new Date(snapshot.at).toISOString(), size: snapshot.size } : null;
	}

	/**
	 * Warm this, the repo's own Gate, on main in the background, so it saves
	 * the repo's snapshot that the changes' Gates, builders and reviewers start
	 * from (see snapshotIfDue). It never runs a change's checks, so what it
	 * saves is only ever main. Asked for when the checks are set up (always),
	 * when a merge is near (only while there's no usable snapshot), and by a
	 * change's Gate that had to set up from scratch. Returns at once; the
	 * alarm does the work.
	 */
	async warmUp(input: WarmUp & { why?: "claimed" | "checked" | "approved" | "set up" }) {
		const { why, ...warming } = input;
		// With a snapshot, a cold container restores in seconds: a merge near needs no head start.
		if ((why === "claimed" || why === "checked" || why === "approved") && (await this.snapshot())) return;
		await this.ctx.storage.put("warmUp", warming);
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** The repo's checks for the checkout here, with the install a Node project needs first (see withInstall). */
	private async checksFor(container: Container, checks: string[]) {
		const found = await run(container, ["bash", "-c", "[ -f package.json ] && echo package.json; [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ] && echo lockfile; true"]);
		return withInstall(checks, { packageJson: found.output.includes("package.json"), npmLockfile: found.output.includes("lockfile") });
	}

	/**
	 * What an install depends on: package.json's dependency sections (not its
	 * scripts, say) and whichever lockfile there is. Without a lockfile
	 * (Express has none), every install resolves every dependency from the
	 * registry again, so skipping an unchanged one matters.
	 */
	private async lockHash(container: Container) {
		const deps = `node -e 'try { const p = require("./package.json"); console.log(JSON.stringify(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "workspaces"].map((k) => p[k] ?? null))) } catch { console.log("none") }'`;
		const r = await run(container, ["bash", "-lc", `{ ${deps}; cat package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml 2>/dev/null; } | sha256sum | cut -d' ' -f1`]);
		return r.output.trim();
	}

	/** Dependencies are installed and what they depend on matches the last install. */
	private async installUnchanged(container: Container) {
		const last = await this.ctx.storage.get<string>("lockHash");
		if (!last) return false;
		const installed = await run(container, ["test", "-d", "node_modules"]);
		return installed.exitCode === 0 && (await this.lockHash(container)) === last;
	}
}
