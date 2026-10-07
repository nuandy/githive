import { DurableObject } from "cloudflare:workers";
import { WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import { statusOf } from "./errors";
import { CheckLine, type LineResult } from "./toolkit/check-line";
import { branchHead } from "./git";

// The project's checks, run before a merge lands: the change merged onto the
// project's branch (after the merges ahead of it in line) and the checks run
// on the combined code, in a container. No model is involved.
//
// A repo's Gate keeps its line of merges waiting for checks and runs them in
// batches, itself and the Gates beside it each checking one (see
// toolkit/check-line.ts), in containers it keeps warm: dependencies stay
// installed between runs, and an install is skipped while what it depends on
// is unchanged.

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

const INSTALL = /^npm ci(\s|$)/;
/** A check that installs dependencies (any of the usual package managers): what warming a container runs. */
const INSTALLS = /^(npm|pnpm|yarn)\s+(ci|install)(\s|$)/;
/** How long a container stays up with nothing to run: through a burst of merges. */
const IDLE_MS = 20 * 60_000;
/** A container warmed this recently isn't warmed again. */
const WARM_FOR_MS = 5 * 60_000;
/** Lanes to warm, the repo's own Gate first (see check-line.ts LANES). */
const WARM_LANES = 4;

/** A merge's checks: the project's branch and checks, and the change's fork and commit. */
export interface ChangeCheck {
	branch?: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string; ref: string };
	head: string;
	checks: string[];
}

export class Gate extends DurableObject<Env> {
	/** Checks run one at a time: there is one container, and one checkout in it. */
	private checking: Promise<unknown> = Promise.resolve();

	/**
	 * Check one commit now: merge `head` onto `baseHead` (after the merges
	 * ahead) and run `checks`, returning the result. A lane of the repo's line.
	 */
	checkCommit(input: ChangeCheck & { baseHead: string; ahead?: CheckPlan["ahead"] }): Promise<GateResult> {
		const plan: CheckPlan = { baseHead: input.baseHead, branch: input.branch, base: input.base, fork: input.fork, ...(input.ahead?.length ? { ahead: input.ahead } : {}), checks: input.checks };
		const run = this.checking.then(async () => {
			try {
				return await this.check(input.head, plan);
			} catch (err) {
				await this.ctx.storage.delete("prepared");
				return { passed: false, head: input.head, baseHead: input.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: statusOf(err).message }], at: new Date().toISOString() } satisfies GateResult;
			}
		});
		this.checking = run.catch(() => {});
		return run;
	}

	/** The line of merges waiting for checks, for the repo this Gate serves (see check-line.ts). */
	private line?: CheckLine<ChangeCheck & { repo: string }, GateResult>;

	/**
	 * Wait in the repo's line for a merge's checks: run, in a batch, on the
	 * project's branch with the merges ahead merged in first. This Gate is the
	 * first lane; the others are Gates of their own, each with its container.
	 */
	checkInLine(input: ChangeCheck & { repo: string; change: string }): Promise<LineResult<GateResult>> {
		this.line ??= new CheckLine({
			base: async (check) => (await branchHead({ url: check.base.remote, token: check.base.token }, check.branch ?? "main")) ?? Promise.reject(new Error(`the project has no ${check.branch ?? "main"} branch`)),
			check: (lane, request, baseHead, ahead) => {
				const check = { ...request.input, baseHead, ahead: ahead.map((a) => ({ head: a.head, remote: a.input.fork.remote, token: a.input.fork.token, ref: a.input.fork.ref })) };
				return lane === 0 ? this.checkCommit(check) : this.env.GATE.getByName(`repo:${request.input.repo}:lane:${lane}`).checkCommit(check);
			},
		});
		const { repo, change, ...check } = input;
		return this.line.join({ change, head: input.head, input: { ...check, repo } });
	}

	/** A merge checked in line is done with its result: it landed, or (landed false) gave up. */
	lineDone(change: string, landed = true) {
		this.line?.done(change, landed);
	}

	async alarm() {
		// The repo's lanes to warm (see warmLanes).
		const warmLanes = await this.ctx.storage.get<{ repo: string; branch?: string; base: { remote: string; token: string }; checks: string[] }>("warmLanes");
		if (!warmLanes) return;
		await this.ctx.storage.delete("warmLanes");
		const { repo, ...input } = warmLanes;
		await Promise.all(Array.from({ length: WARM_LANES }, (_, lane) => (lane === 0 ? this.warm(input) : this.env.GATE.getByName(`repo:${repo}:lane:${lane}`).warm(input)).catch(() => undefined)));
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

		await this.prepare(container, plan.base);

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

		// Checks run on a fresh checkout. If none installs dependencies but the
		// project has a lockfile, install them first, or every check fails on
		// missing tools.
		const checks = [...plan.checks];
		if (!checks.some((c) => INSTALL.test(c.trim())) && (await run(container, ["test", "-f", "package-lock.json"])).exitCode === 0) checks.unshift("npm ci");

		const results = [];
		for (const command of checks) {
			if (INSTALLS.test(command.trim()) && (await this.installUnchanged(container))) {
				results.push({ command, exitCode: 0, output: "Skipped: package.json and its lockfile are unchanged since the last install in this gate." });
				continue;
			}
			const r = await run(container, ["bash", "-lc", command], WORKDIR, undefined, 600);
			results.push({ command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
			if (INSTALLS.test(command.trim())) await this.ctx.storage.put("lockHash", await this.lockHash(container));
		}
		return result({ passed: results.length === checks.length && results.every((r) => r.exitCode === 0), results });
	}

	/** A running container with the project checked out: reused (with its installed dependencies) while it lives. */
	private async prepare(container: Container, base: { remote: string; token: string }) {
		if (!container.running || !(await this.ctx.storage.get<boolean>("prepared"))) {
			await bootContainer(container);
			await run(container, ["rm", "-rf", WORKDIR], "/");
			const clone = await gitWithToken(container, base.token, ["clone", "--quiet", base.remote, WORKDIR], "/");
			if (clone.exitCode !== 0) throw new Error(`clone of the project failed: ${clip(clone.output, 2_000)}`);
			await this.ctx.storage.delete("lockHash");
			await this.ctx.storage.put("prepared", true);
		}
		await container.setInactivityTimeout(IDLE_MS);
	}

	/**
	 * Warm this container for a repo's checks before a merge
	 * needs them: running, the project's branch checked out, and its install
	 * step run once, so the merge's checks start from installed dependencies.
	 * In turn with checks (one checkout); skipped if warmed in the last minutes.
	 */
	warm(input: { branch?: string; base: { remote: string; token: string }; checks: string[] }): Promise<void> {
		const warming = this.checking.then(async () => {
			const container = this.ctx.container;
			if (!container) return;
			const at = await this.ctx.storage.get<number>("warmedAt");
			if (container.running && at && Date.now() - at < WARM_FOR_MS) return;
			await this.ctx.storage.put("warmingSince", Date.now());
			try {
				await this.prepare(container, input.base);
				const branch = input.branch ?? "main";
				const fetched = await gitWithToken(container, input.base.token, ["fetch", "-q", input.base.remote, `${branch}:refs/remotes/base/${branch}`, "--force"]);
				if (fetched.exitCode !== 0) return;
				await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach refs/remotes/base/${branch} && git clean -fdq`]);
				const install = input.checks.find((c) => INSTALLS.test(c.trim()));
				if (install && !(await this.installUnchanged(container))) {
					const installed = await run(container, ["bash", "-lc", install], WORKDIR, undefined, 600);
					if (installed.exitCode === 0) await this.ctx.storage.put("lockHash", await this.lockHash(container));
				}
				await this.ctx.storage.put("warmedAt", Date.now());
			} catch (err) {
				// Warming is a head start, never a requirement: the check prepares what it needs.
				console.error("warming a gate container failed", statusOf(err).message);
				await this.ctx.storage.delete(["prepared", "warmingSince"]);
			}
		});
		this.checking = warming.catch(() => {});
		return warming;
	}

	/** This container's warmth: whether it runs, when it last finished warming, and whether it's warming now. */
	async warmth() {
		const [warmedAt, warmingSince] = await Promise.all([this.ctx.storage.get<number>("warmedAt"), this.ctx.storage.get<number>("warmingSince")]);
		return {
			running: !!this.ctx.container?.running,
			warmedAt: warmedAt ?? null,
			warming: !!warmingSince && (!warmedAt || warmingSince > warmedAt),
		};
	}

	/** The warmth of the repo's lanes (this Gate first, then the ones beside it). */
	async lanes(repo: string) {
		return Promise.all(Array.from({ length: WARM_LANES }, async (_, lane) => ({ lane, ...(await (lane === 0 ? this.warmth() : this.env.GATE.getByName(`repo:${repo}:lane:${lane}`).warmth())) })));
	}

	/**
	 * Warm the repo's lanes (this Gate and the ones beside it) in the
	 * background: called when a merge is likely soon (a change was checked or
	 * approved). Returns at once; the alarm does the work.
	 */
	async warmLanes(input: { repo: string; branch?: string; base: { remote: string; token: string }; checks: string[] }) {
		if (!input.checks.length) return;
		await this.ctx.storage.put("warmLanes", input);
		await this.ctx.storage.setAlarm(Date.now());
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
