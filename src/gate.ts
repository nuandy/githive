import { DurableObject } from "cloudflare:workers";
import { type InstanceSize, type SetupSnapshot, WORKDIR, bootContainer, clip, gitWithToken, installToolchains, outOfMemory, run } from "./container";
import { statusOf } from "./errors";
import { DEPENDENCIES, DEPENDENCY_FILES } from "./toolchains";

// The project's checks, run before a merge lands: the change merged onto the
// project's branch (after the merges ahead of it in line) and the checks run
// on the combined code, in a container. No model is involved.
//
// A repo's Gate keeps its line of merges waiting for checks and runs them in
// batches, itself and the Gates beside it each checking one (see
// toolkit/check-line.ts), in containers it keeps warm: dependencies stay
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
	/** Merges ahead in the line: merged in, in order, before the commit checked (see check-line.ts). */
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

	/** Run `work` in turn with the container's other work, keeping the container up meanwhile, and after it. */
	private inTurn<T>(work: () => Promise<T>): Promise<T> {
		this.active++;
		const run = this.checking.then(work).finally(async () => {
			this.active--;
			await this.ctx.storage.put("lastActive", Date.now());
			await this.scheduleStop();
		});
		this.checking = run.catch(() => {});
		return run;
	}

	/**
	 * Check one commit now: merge `head` onto `baseHead` (after the merges
	 * ahead) and run `checks`, returning the result. A change's own Gate
	 * (repo:<repo>:change:<change>) runs its checks in the line (see line.ts).
	 */
	checkCommit(input: ChangeCheck & { baseHead: string; ahead?: CheckPlan["ahead"] }): Promise<GateResult> {
		const plan: CheckPlan = { ...(input.repo ? { repo: input.repo } : {}), baseHead: input.baseHead, branch: input.branch, base: input.base, fork: input.fork, ...(input.ahead?.length ? { ahead: input.ahead } : {}), checks: input.checks };
		return this.inTurn(async () => {
			try {
				return await this.check(input.head, plan);
			} catch (err) {
				await this.ctx.storage.delete("prepared");
				return { passed: false, head: input.head, baseHead: input.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: statusOf(err).message }], at: new Date().toISOString() } satisfies GateResult;
			}
		});
	}

	/** Make sure an alarm comes by `at` (an earlier one stays). */
	private async alarmBy(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	/** Plan the container's stop: an alarm a grace after its last run; none while it isn't running. */
	private async scheduleStop() {
		if (!this.ctx.container?.running) return;
		await this.alarmBy(((await this.ctx.storage.get<number>("lastActive")) ?? Date.now()) + GRACE_MS);
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
		const at = ((await this.ctx.storage.get<number>("lastActive")) ?? 0) + GRACE_MS;
		if (at > Date.now()) return this.alarmBy(at);
		await container.destroy("nothing to check");
		const started = await this.ctx.storage.get<{ at: number; repo: string | null; own: boolean; size: InstanceSize }>("started");
		if (started) console.log(JSON.stringify({ event: "check container stopped", repo: started.repo, gate: started.own ? "repo" : "change", size: started.size, seconds: Math.round((Date.now() - started.at) / 1000) }));
		await this.ctx.storage.delete(["prepared", "started"]);
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
		// Fetch the change's branch (fetching a bare commit hash depends on server settings);
		// the approved commit is in its history.
		const fork = await gitWithToken(container, plan.fork.token, ["fetch", "-q", plan.fork.remote, `${plan.fork.ref}:refs/remotes/change/head`, "--force"]);
		if (fork.exitCode !== 0) throw new Error(`fetch of the change failed: ${clip(fork.output, 2_000)}`);
		const known = await run(container, ["git", "cat-file", "-e", `${head}^{commit}`]);
		if (known.exitCode !== 0) throw new Error(`the approved commit ${head} is not on the change's branch`);
		for (const [k, ahead] of (plan.ahead ?? []).entries()) {
			const f = await gitWithToken(container, ahead.token, ["fetch", "-q", ahead.remote, `${ahead.ref ?? branch}:refs/remotes/ahead-${k}/head`, "--force"]);
			if (f.exitCode !== 0) throw new Error(`fetch of a merge ahead in line failed: ${clip(f.output, 2_000)}`);
		}

		// A clean checkout of the base; ignored files (node_modules) survive `git clean -fd`.
		await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${plan.baseHead} && git clean -fdq`]);
		// Merge the merges ahead in line, in order, then the change, onto the base.
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
		return this.inTurn(async () => {
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
	async warmUp(input: WarmUp & { why?: "checked" | "approved" | "set up" }) {
		if (!input.checks.length) return;
		const { why, ...warming } = input;
		if ((why === "checked" || why === "approved") && (await this.snapshot())) return;
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
