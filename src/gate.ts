import { DurableObject } from "cloudflare:workers";
import { type InstanceSize, type SetupSnapshot, WORKDIR, bootContainer, clip, outOfMemory, run } from "./container";
import { statusOf } from "./errors";
import { rpc } from "./rpc";
import { mergeForCheck } from "./gate-check";
import { type ContainerStart, cloneProject, logGitRequests, logStopped } from "./gate-container";
import { checkoutDetached, fetchBase } from "./gate-git";
import { checksFor, installMatches, isInstall, lockHash, setUpToolchains, skippedInstall } from "./gate-install";
import {
	type ChecksBranch,
	type LandedPush,
	type LandingMerge,
	type LandingResult,
	type ReadChange,
	fetchBatchBase,
	landMerges,
	pushForChecks,
	pushLanded,
	readChanges,
} from "./gate-landing";
import { saveSnapshotIfDue, snapshotUsable } from "./gate-snapshot";
import type { BatchBase, BatchSource, ChangeCheck, CheckPlan, CheckResult, GateResult, WarmUp } from "./gate-types";

export { withInstall } from "./gate-install";
export { pushBusy } from "./gate-landing";
export { snapshotDue } from "./gate-snapshot";
export type { BatchSource, ChangeCheck, CheckResult, GateResult, WarmUp } from "./gate-types";

// The project's checks, run in a container before changes land. A batch of changes is merged onto the project's
// branch in order, and the checks run on the combined code.
//
// A change's Gate checks the batches that end in it (see toolkit/merge.ts). The repo's own Gate reads and lands
// batches. It never runs a change's code, so it can be trusted with what a change touched and with the token that
// writes the project's branch.

/** How long a container stays up after its last run, so a check that follows soon can reuse it. */
export const GRACE_MS = 60_000;
/** How long the repo's own Gate keeps a batch's changes fetched, waiting for the batch to land. */
const BATCH_HOLD_MS = 5 * 60_000;
/** A backstop: the platform stops a container idle this long if GitHive's own stop never comes. */
const SAFETY_MS = 30 * 60_000;
const WARM_FOR_MS = 60_000;

/** Check containers start small and move to large once a repo's checks run out of memory. */
const SMALL: InstanceSize = "small";
const LARGE: InstanceSize = "large";
const CHECK_TIMEOUT_S = 600;

export class Gate extends DurableObject<Env> {
	/** Work runs one at a time because the container has a single checkout. */
	private checking: Promise<unknown> = Promise.resolve();
	/** Work running or queued. The container stays up while there is any. */
	private active = 0;

	/** Runs `work` after the container's other work, keeping the container up, then logs its Git requests. */
	private inTurn<T>(what: string, repo: string | undefined, work: () => Promise<T>): Promise<T> {
		this.active++;
		const run = this.checking.then(work).finally(async () => {
			await logGitRequests(this.ctx.container, what, repo).catch(() => undefined);
			this.active--;
			await this.ctx.storage.put("lastActive", Date.now());
			await this.scheduleStop();
		});
		this.checking = run.catch(() => {});
		return run;
	}

	/**
	 * Merges `head` onto `baseHead` after the batch's earlier changes and runs the checks. This runs in the Gate of the
	 * batch's last change.
	 */
	checkCommit(input: ChangeCheck & { baseHead: string; ahead?: CheckPlan["ahead"] }): Promise<GateResult> {
		const plan: CheckPlan = {
			...(input.repo ? { repo: input.repo } : {}),
			baseHead: input.baseHead,
			branch: input.branch,
			base: input.base,
			fork: input.fork,
			...(input.ahead?.length ? { ahead: input.ahead } : {}),
			checks: input.checks,
		};
		return this.inTurn("check", input.repo, async () => {
			try {
				return await this.check(input.head, plan);
			} catch (err) {
				await this.ctx.storage.delete("prepared");
				return {
					passed: false,
					head: input.head,
					baseHead: input.baseHead,
					results: [{ command: "(gate setup)", exitCode: 1, output: statusOf(err).message }],
					at: new Date().toISOString(),
				} satisfies GateResult;
			}
		});
	}

	/**
	 * Reads each change's current head and the files it changed since it left `baseHead`. Only the repo's own Gate does
	 * this, because a Gate that ran a change's code can't be trusted to report what a change touched.
	 */
	inspectBatch(input: BatchBase & { changes: BatchSource[] }): Promise<ReadChange[]> {
		return this.landing("inspectBatch", input, async (container) => {
			const read = await readChanges(container, input.baseHead, input.changes);
			// Keep the changes fetched for the batch's landing.
			await this.ctx.storage.put("holdUntil", Date.now() + BATCH_HOLD_MS);
			return read;
		});
	}

	/**
	 * Lands a batch in the repo's own Gate. Each change becomes its own merge commit, and all are pushed at once so the
	 * branch is never partway through a batch. Returns `moved` if the branch is no longer at `baseHead`.
	 */
	landBatch(input: BatchBase & { merges: LandingMerge[]; by?: string }): Promise<LandingResult> {
		return this.landing("landBatch", input, async (container) => {
			const kept = async (heads: string[]) =>
				rpc(this.env.REPO_CACHE.getByName(`repo:${input.repo}`).changePacks(heads));
			const landed = await landMerges(container, input, this.env.STAMP_KEY, kept);
			if ("commits" in landed) await this.ctx.storage.delete("holdUntil");
			return landed;
		});
	}

	/**
	 * Merges a batch onto `baseHead` as it will land and pushes it to `ref` on a connected GitHub repo, whose Actions
	 * check it. This runs with real git in the repo's own Gate, not in a Worker's memory.
	 */
	checksBranch(input: BatchBase & ChecksBranch): Promise<{ tip: string } | { failed: string }> {
		return this.landing("checksBranch", input, (container) => pushForChecks(container, input));
	}

	/**
	 * Pushes `branch` at `head` to a connected GitHub repo after a landing. The push is a fast-forward only, so commits
	 * someone pushed there directly are never overwritten.
	 */
	pushBranch(input: Omit<BatchBase, "baseHead"> & LandedPush): Promise<{ pushed: true } | { refused: string }> {
		return this.landing("pushBranch", { ...input, baseHead: input.head }, (container) => pushLanded(container, input));
	}

	/**
	 * Runs landing work in turn in the repo's own Gate, once the container has the project's branch and `baseHead`.
	 * Batches are read and landed only there.
	 */
	private landing<T>(what: string, input: BatchBase, work: (container: Container) => Promise<T>): Promise<T> {
		return this.inTurn(what, input.repo, async () => {
			const container = this.ctx.container;
			if (!container) throw new Error("no container is configured for Gate");
			if (!this.ownsSnapshot(input.repo))
				throw new Error("only the repo's own Gate reads and lands batches: a change's Gate runs that change's code");
			await this.prepare(container, input.base, input.repo);
			await fetchBatchBase(container, input);
			return work(container);
		});
	}

	/**
	 * Starts the container while a batch is still being read, so its first check or its landing finds it running.
	 */
	boot(input: { repo: string; base: { remote: string; token: string } }): Promise<void> {
		return this.inTurn("boot", input.repo, async () => {
			const container = this.ctx.container;
			if (container) await this.prepare(container, input.base, input.repo);
		});
	}

	/** Makes sure an alarm fires by `at`, keeping an earlier one. */
	private async alarmBy(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	/** Sets an alarm to stop the container a grace period after its last run. */
	private async scheduleStop() {
		if (!this.ctx.container?.running) return;
		await this.alarmBy(await this.stopTime(Date.now()));
	}

	/**
	 * When the idle container may stop: a grace period after its last run, or later while a batch that was read waits
	 * to land. `lastActiveDefault` stands in when no run was recorded.
	 */
	private async stopTime(lastActiveDefault: number) {
		const lastActive = (await this.ctx.storage.get<number>("lastActive")) ?? lastActiveDefault;
		const holdUntil = (await this.ctx.storage.get<number>("holdUntil")) ?? 0;
		return Math.max(lastActive + GRACE_MS, holdUntil);
	}

	async alarm() {
		const warmUp = await this.ctx.storage.get<WarmUp>("warmUp");
		if (warmUp) {
			await this.ctx.storage.delete("warmUp");
			await this.warm(warmUp).catch(() => undefined);
		}
		await this.stopIfIdle();
	}

	/** Stops the container once no work is running or queued and the grace period has passed. */
	private async stopIfIdle() {
		const container = this.ctx.container;
		if (!container?.running) return;
		if (this.active > 0) return this.alarmBy(Date.now() + GRACE_MS);
		// A batch that was read but not landed keeps it up longer, so the landing finds its changes fetched.
		const at = await this.stopTime(0);
		if (at > Date.now()) return this.alarmBy(at);
		await container.destroy("nothing to check");
		const started = await this.ctx.storage.get<ContainerStart>("started");
		if (started) logStopped(started);
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
		const conflicts = await mergeForCheck(container, head, plan);
		if (conflicts) return result({ mergeConflict: conflicts });

		// From here the change's own code runs, so this container must never be saved as the repo's snapshot.
		await this.ctx.storage.put("tainted", true);
		const checks = await checksFor(container, plan.checks);

		// Toolchains are read from the merged code, since a change may add one.
		const setup = await this.setUpToolchains(container);
		if (setup.some((r) => r.exitCode !== 0)) return result({ results: setup });

		const results = await this.runChecks(container, checks);
		if (!results) return this.check(head, plan);
		// This Gate had to set up or install more than the snapshot held, so ask the repo's own Gate to refresh it.
		const installed = results.some((r) => isInstall(r.command) && !r.output.startsWith("Skipped"));
		if (plan.repo && !this.ownsSnapshot(plan.repo) && (started === "fresh" || installed))
			this.askForWarmUp(plan.repo, plan);
		return result({
			passed: results.length === checks.length && results.every((r) => r.exitCode === 0),
			results: [...setup, ...results],
		});
	}

	/**
	 * Runs the checks in order until one fails. Returns undefined when they ran out of memory and the container moved
	 * up to large, so the caller checks again.
	 */
	private async runChecks(container: Container, checks: string[]): Promise<CheckResult[] | undefined> {
		const results: CheckResult[] = [];
		for (const command of checks) {
			if (isInstall(command) && (await this.installUnchanged(container))) {
				results.push(skippedInstall(command));
				continue;
			}
			const started = Date.now();
			const ran = await run(container, ["bash", "-lc", command], WORKDIR, undefined, CHECK_TIMEOUT_S);
			if (outOfMemory(ran.exitCode, Date.now() - started, CHECK_TIMEOUT_S) && (await this.size()) !== LARGE) {
				// Killed for memory, not time. Move this repo to the larger container and check again.
				console.log(`checks ran out of memory in a ${SMALL} container: moving up to ${LARGE}`);
				await this.ctx.storage.put("instance", LARGE);
				await container.destroy(`checks ran out of memory in ${SMALL}`);
				await this.ctx.storage.delete(["prepared", "lockHash", "depsHash"]);
				return undefined;
			}
			results.push({ command, exitCode: ran.exitCode, output: clip(ran.output, 6_000) });
			if (ran.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
			if (isInstall(command)) await this.ctx.storage.put("lockHash", await lockHash(container));
		}
		return results;
	}

	/** Asks the repo's own Gate to warm up in the background, so it refreshes the repo's snapshot. */
	private askForWarmUp(repo: string, plan: CheckPlan) {
		void this.env.GATE.getByName(`repo:${repo}`)
			.warmUp({
				repo,
				...(plan.branch ? { branch: plan.branch } : {}),
				base: plan.base,
				checks: plan.checks,
			})
			.catch(() => undefined);
	}

	/** Installs the checkout's toolchains and their dependencies. A failed install is returned as a failed check. */
	private setUpToolchains(container: Container): Promise<CheckResult[]> {
		return setUpToolchains(container, this.ctx.storage);
	}

	/**
	 * Makes sure the container is running with the project checked out. A new one starts from the repo's snapshot when
	 * there is one, so it fetches and installs only what changed since.
	 */
	private async prepare(
		container: Container,
		base: { remote: string; token: string },
		repo?: string,
	): Promise<"ready" | "restored" | "fresh"> {
		let started: "ready" | "restored" | "fresh" = "ready";
		if (!container.running || !(await this.ctx.storage.get<boolean>("prepared"))) {
			started = await this.start(container, base, repo);
			await this.ctx.storage.put("prepared", true);
		}
		// GitHive stops it when idle (see stopIfIdle). This is the backstop.
		await container.setInactivityTimeout(SAFETY_MS);
		return started;
	}

	/** Boots the container from the repo's snapshot, or else from the image with the project cloned. */
	private async start(
		container: Container,
		base: { remote: string; token: string },
		repo?: string,
	): Promise<"restored" | "fresh"> {
		const snapshot = repo ? await this.snapshotFor(repo) : null;
		const size = await this.size();
		const booted = await bootContainer(container, size, snapshot);
		// Recorded for the log line at stop, which shows what the container cost.
		if (booted !== "running")
			await this.ctx.storage.put("started", {
				at: Date.now(),
				repo: repo ?? null,
				own: !!repo && this.ownsSnapshot(repo),
				size,
			} satisfies ContainerStart);
		if (booted === "restored" && snapshot) {
			await this.ctx.storage.delete(["lockHash", "depsHash", "tainted"]);
			await this.ctx.storage.put({
				...(snapshot.lockHash ? { lockHash: snapshot.lockHash } : {}),
				...(snapshot.depsHash ? { depsHash: snapshot.depsHash } : {}),
			});
			console.log(`gate container started at ${size} from ${repo}'s snapshot`);
			return "restored";
		}
		if (snapshot && repo) await this.snapshotUnusable(repo, snapshot.id);
		await cloneProject(container, base, size);
		await this.ctx.storage.delete(["lockHash", "depsHash"]);
		// A container that was already running may have run a change's code; a fresh one hasn't.
		if (booted === "fresh") await this.ctx.storage.delete("tainted");
		else await this.ctx.storage.put("tainted", true);
		return "fresh";
	}

	/** Whether this is the repo's own Gate, which keeps the repo's snapshot. */
	private ownsSnapshot(repo: string) {
		const own = this.env.GATE?.idFromName?.(`repo:${repo}`);
		return !!own && !!this.ctx.id?.equals?.(own);
	}

	private async snapshotFor(repo: string): Promise<SetupSnapshot | null> {
		if (this.ownsSnapshot(repo)) return this.snapshot();
		return this.env.GATE.getByName(`repo:${repo}`)
			.snapshot()
			.catch(() => null);
	}

	/** Forgets a snapshot that failed to start, so the next warm-up takes a new one. */
	private async snapshotUnusable(repo: string, id: string) {
		if (this.ownsSnapshot(repo)) return this.forgetSnapshot(id);
		await this.env.GATE.getByName(`repo:${repo}`)
			.forgetSnapshot(id)
			.catch(() => undefined);
	}

	/** The repo's snapshot for Gates, reviewers and builders to start from, or null if it may have expired. */
	async snapshot(): Promise<SetupSnapshot | null> {
		const snapshot = await this.ctx.storage.get<SetupSnapshot>("snapshot");
		return snapshot && snapshotUsable(snapshot) ? snapshot : null;
	}

	/** Forgets the repo's snapshot. With `id`, only that snapshot is forgotten, so a newer one stays. */
	async forgetSnapshot(id?: string) {
		const snapshot = await this.ctx.storage.get<SetupSnapshot>("snapshot");
		if (snapshot && (!id || snapshot.id === id)) await this.ctx.storage.delete("snapshot");
	}

	/** Saves this container as the repo's snapshot when one is due and the container has never run a change's code. */
	private async snapshotIfDue(container: Container, repo?: string) {
		if (!repo || !this.ownsSnapshot(repo) || (await this.ctx.storage.get<boolean>("tainted"))) return;
		await saveSnapshotIfDue(container, this.ctx.storage, repo);
	}

	/**
	 * Warms this container before a merge needs it, with the project's branch checked out and its install step run, so
	 * the merge's checks start from installed dependencies.
	 */
	warm(input: Partial<Pick<WarmUp, "repo">> & Omit<WarmUp, "repo">): Promise<void> {
		return this.inTurn("warm", input.repo, async () => {
			const container = this.ctx.container;
			if (!container) return;
			const at = await this.ctx.storage.get<number>("warmedAt");
			if (container.running && at && Date.now() - at < WARM_FOR_MS) return;
			await this.ctx.storage.put("warmingSince", Date.now());
			try {
				await this.warmOn(container, input);
			} catch (err) {
				// Warming is only a head start. The check prepares what it needs.
				console.error("warming a gate container failed", statusOf(err).message);
				await this.ctx.storage.delete(["prepared", "warmingSince"]);
			}
		});
	}

	/** Prepares the container on the project's branch, installs what its checks need and saves a snapshot if due. */
	private async warmOn(container: Container, input: Partial<Pick<WarmUp, "repo">> & Omit<WarmUp, "repo">) {
		await this.prepare(container, input.base, input.repo);
		const branch = input.branch ?? "main";
		const fetched = await fetchBase(container, input.base, branch);
		if (fetched.exitCode !== 0) return;
		// Without checks, warm only for landing batches. Saving the cloned project as the snapshot lets a
		// cold Gate restore in seconds instead of starting from the image and cloning.
		if (input.checks.length) {
			await checkoutDetached(container, `refs/remotes/base/${branch}`);
			await this.setUpToolchains(container);
			await this.installForChecks(container, input.checks);
		}
		await this.ctx.storage.put("warmedAt", Date.now());
		await this.snapshotIfDue(container, input.repo);
	}

	/** Runs the checks' install step unless the installed dependencies already match. */
	private async installForChecks(container: Container, checks: string[]) {
		const install = (await checksFor(container, checks)).find(isInstall);
		if (!install || (await this.installUnchanged(container))) return;
		const installed = await run(container, ["bash", "-lc", install], WORKDIR, undefined, 600);
		if (installed.exitCode === 0) await this.ctx.storage.put("lockHash", await lockHash(container));
	}

	private async size(): Promise<InstanceSize> {
		return (await this.ctx.storage.get<InstanceSize>("instance")) ?? SMALL;
	}

	/** Whether the container runs, its size, and its warming state, for the dashboard. */
	async warmth() {
		const [warmedAt, warmingSince, size] = await Promise.all([
			this.ctx.storage.get<number>("warmedAt"),
			this.ctx.storage.get<number>("warmingSince"),
			this.size(),
		]);
		return {
			running: !!this.ctx.container?.running,
			size,
			warmedAt: warmedAt ?? null,
			warming: !!warmingSince && (!warmedAt || warmingSince > warmedAt),
		};
	}

	/** When the repo's snapshot was taken and its size, for the dashboard. */
	async snapshotInfo() {
		const snapshot = await this.snapshot();
		return snapshot ? { at: new Date(snapshot.at).toISOString(), size: snapshot.size } : null;
	}

	/**
	 * Warms the repo's own Gate on main in the background, so it saves the snapshot that other Gates, builders and
	 * reviewers start from. It never runs a change's checks, so the snapshot only ever holds main.
	 */
	async warmUp(input: WarmUp & { why?: "claimed" | "checked" | "approved" | "set up" }) {
		const { why, ...warming } = input;
		// With a snapshot, a cold container restores in seconds, so an upcoming merge needs no head start.
		if ((why === "claimed" || why === "checked" || why === "approved") && (await this.snapshot())) return;
		await this.ctx.storage.put("warmUp", warming);
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Whether dependencies are installed and match the last install. */
	private async installUnchanged(container: Container) {
		return installMatches(container, await this.ctx.storage.get<string>("lockHash"));
	}
}
