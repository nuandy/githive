import { DurableObject } from "cloudflare:workers";
import { type InstanceSize, WORKDIR, bootContainer, clip, gitWithToken, installToolchains, outOfMemory, run } from "./container";
import { statusOf } from "./errors";
import { CheckLine, LANES, type LineResult } from "./toolkit/check-line";
import { branchHead } from "./git";
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
/**
 * Why a merge is expected soon: a change was checked after a push, or
 * approved, or the repo's checks were just set up (start, settings).
 */
export type MergeExpected = "checked" | "approved" | "set up";
/**
 * How long a check container waits for an expected merge. Its memory is paid
 * for while it waits, and past about 2 minutes waiting costs more than
 * starting again cold, so it doesn't wait much longer than that.
 */
export const EXPECT_MS: Record<MergeExpected, number> = { checked: 3 * 60_000, approved: 3 * 60_000, "set up": 2 * 60_000 };
/** How long a container stays up after its last run once no merge is expected: long enough for a merge that follows at once. */
export const GRACE_MS = 60_000;
/** The platform stops a container left this long, in case GitHive's own stop never comes. */
const SAFETY_MS = 30 * 60_000;
/** A container warmed this recently isn't warmed again. */
const WARM_FOR_MS = 60_000;

/**
 * When a check container may stop: a grace after its last run, and not
 * before any merge it expects is due (`expecting`: deadlines, by key).
 */
export function stopAt(lastActive: number, expecting: Record<string, number>) {
	return Math.max(lastActive + GRACE_MS, ...Object.values(expecting));
}
/** A check container's size: small at first, larger once a repo's checks run out of memory in it (see check). */
const SMALL: InstanceSize = "small";
const LARGE: InstanceSize = "large";
/** How long one check command may run. */
const CHECK_TIMEOUT_S = 600;

/**
 * Lanes warmed ahead of a merge: the repo's own Gate only. The others start
 * when a batch needs them (several merges at once), so a quiet repo pays for
 * one container, not LANES.
 */
const WARM_LANES = 1;

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
	/** Checks and warm-ups running or waiting their turn: while any is, the container stays up. */
	private active = 0;
	/** The commit each merge in line was checked at: its approval's expectation goes when it's done. */
	private readonly heads = new Map<string, string>();

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
	 * ahead) and run `checks`, returning the result. A lane of the repo's line.
	 */
	checkCommit(input: ChangeCheck & { baseHead: string; ahead?: CheckPlan["ahead"] }): Promise<GateResult> {
		const plan: CheckPlan = { baseHead: input.baseHead, branch: input.branch, base: input.base, fork: input.fork, ...(input.ahead?.length ? { ahead: input.ahead } : {}), checks: input.checks };
		return this.inTurn(async () => {
			try {
				return await this.check(input.head, plan);
			} catch (err) {
				await this.ctx.storage.delete("prepared");
				return { passed: false, head: input.head, baseHead: input.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: statusOf(err).message }], at: new Date().toISOString() } satisfies GateResult;
			}
		});
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
		this.heads.set(change, input.head);
		return this.line.join({ change, head: input.head, input: { ...check, repo } });
	}

	/** A merge checked in line is done with its result: it landed, or (landed false) gave up. Either way it's no longer expected. */
	async lineDone(change: string, landed = true) {
		this.line?.done(change, landed);
		const head = this.heads.get(change);
		this.heads.delete(change);
		await this.notExpecting(change, ...(head ? [head] : []));
	}

	/** Merges no longer expected (merged, given up, or their claim released): the container need not wait for them. */
	async notExpecting(...keys: string[]) {
		const expecting = await this.expecting();
		for (const key of keys) delete expecting[key];
		await this.ctx.storage.put("expecting", expecting);
		await this.scheduleStop();
	}

	/** The merges expected soon, by key (a change, or an approved commit), with their deadlines; past ones dropped. */
	private async expecting() {
		const now = Date.now();
		return Object.fromEntries(Object.entries((await this.ctx.storage.get<Record<string, number>>("expecting")) ?? {}).filter(([, due]) => due > now));
	}

	/** Make sure an alarm comes by `at` (an earlier one stays). */
	private async alarmBy(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	/** Plan the container's stop: an alarm when it may (see stopAt); none while it isn't running. */
	private async scheduleStop() {
		if (!this.ctx.container?.running) return;
		await this.alarmBy(stopAt((await this.ctx.storage.get<number>("lastActive")) ?? Date.now(), await this.expecting()));
	}

	async alarm() {
		// The repo's lanes to warm (see warmLanes).
		const warmLanes = await this.ctx.storage.get<{ repo: string; branch?: string; base: { remote: string; token: string }; checks: string[] }>("warmLanes");
		if (warmLanes) {
			await this.ctx.storage.delete("warmLanes");
			const { repo, ...input } = warmLanes;
			await Promise.all(Array.from({ length: WARM_LANES }, (_, lane) => (lane === 0 ? this.warm(input) : this.env.GATE.getByName(`repo:${repo}:lane:${lane}`).warm(input)).catch(() => undefined)));
		}
		await this.stopIfIdle();
	}

	/**
	 * Stop the container once nothing needs it: no check or warm-up running or
	 * waiting, no merge in line, a grace since its last run, and no merge
	 * expected (see stopAt). Otherwise look again when it might be.
	 */
	private async stopIfIdle() {
		const container = this.ctx.container;
		if (!container?.running) return;
		if (this.active > 0 || this.line?.busy()) return this.alarmBy(Date.now() + GRACE_MS);
		const expecting = await this.expecting();
		const at = stopAt((await this.ctx.storage.get<number>("lastActive")) ?? 0, expecting);
		if (at > Date.now()) return this.alarmBy(at);
		await container.destroy("nothing to check");
		await this.ctx.storage.delete(["prepared", "expecting"]);
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

	/** A running container with the project checked out: reused (with its installed dependencies) while it lives. */
	private async prepare(container: Container, base: { remote: string; token: string }) {
		if (!container.running || !(await this.ctx.storage.get<boolean>("prepared"))) {
			await bootContainer(container, await this.size());
			const limits = await run(container, ["bash", "-c", "echo $(nproc) cpus, $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo) MiB"], "/");
			console.log(`gate container started at ${await this.size()}: ${limits.output.trim()}`);
			await run(container, ["rm", "-rf", WORKDIR], "/");
			const clone = await gitWithToken(container, base.token, ["clone", "--quiet", base.remote, WORKDIR], "/");
			if (clone.exitCode !== 0) throw new Error(`clone of the project failed: ${clip(clone.output, 2_000)}`);
			await this.ctx.storage.delete(["lockHash", "depsHash"]);
			await this.ctx.storage.put("prepared", true);
		}
		// GitHive stops it itself once nothing needs it (see stopIfIdle); this is the backstop.
		await container.setInactivityTimeout(SAFETY_MS);
	}

	/**
	 * Warm this container for a repo's checks before a merge
	 * needs them: running, the project's branch checked out, and its install
	 * step run once, so the merge's checks start from installed dependencies.
	 * In turn with checks (one checkout); skipped if warmed in the last minutes.
	 */
	warm(input: { branch?: string; base: { remote: string; token: string }; checks: string[] }): Promise<void> {
		return this.inTurn(async () => {
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
				await this.setUpToolchains(container);
				const install = (await this.checksFor(container, input.checks)).find((c) => INSTALLS.test(c.trim()));
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

	/** The warmth of the repo's lanes (this Gate first, then the ones beside it). */
	async lanes(repo: string) {
		return Promise.all(Array.from({ length: LANES }, async (_, lane) => ({ lane, ...(await (lane === 0 ? this.warmth() : this.env.GATE.getByName(`repo:${repo}:lane:${lane}`).warmth())) })));
	}

	/**
	 * Warm the repo's first lane in the background: called when a merge is
	 * likely soon, saying why (`expect`) and for what (`key`: the change, or
	 * the approved commit), so the container waits for it, and not much
	 * longer (see EXPECT_MS). Returns at once; the alarm does the work.
	 */
	async warmLanes(input: { repo: string; branch?: string; base: { remote: string; token: string }; checks: string[]; expect?: MergeExpected; key?: string }) {
		if (!input.checks.length) return;
		const { expect, key, ...warming } = input;
		if (expect) await this.ctx.storage.put("expecting", { ...(await this.expecting()), [key ?? `(${expect})`]: Date.now() + EXPECT_MS[expect] });
		await this.ctx.storage.put("warmLanes", warming);
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
