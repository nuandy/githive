import { DurableObject } from "cloudflare:workers";
import { taskCoordinator } from "./elected";
import { WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import { statusOf } from "./errors";
import type { GateResult } from "./gate-plan";

// The integration gate ("semantic Merge-ahead"). Before an approved slice is
// integrated, it is merged onto the current task base and the task's verify
// commands run on the combined code. No model is involved.
//
// One Gate per task works through a queue, one slice at a time, in a
// container it keeps warm:
// - Each run asks the Coordinator for its plan when it starts, so it uses the
//   base as it is then. The previous slice is integrated before the next run
//   starts, so runs don't go stale as each other integrate.
// - Dependencies stay installed between runs: `npm ci` is skipped when
//   package-lock.json is unchanged since the last install in this container.

export interface GateItem {
	/** Set when queued; identifies this item when the run finishes. */
	id?: string;
	slice: string;
	/** The approved commit to check. */
	head: string;
	/** Other slices to merge in the same run, when slices depend on each other (a group gate). */
	group?: { slice: string; head: string }[];
	/** Internal marker set when a running item is cancelled. */
	cancelled?: boolean;
}

/** What the Coordinator hands a run when it starts. */
export interface GatePlan {
	baseHead: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string };
	/** The forks of the other slices in a group gate. */
	others: { slice: string; head: string; remote: string; token: string }[];
	checks: string[];
	/** Contract test files to remove first (their slices aren't integrated yet). */
	exclude: string[];
}

const INSTALL = /^npm ci(\s|$)/;
const CANCELLATIONS = "cancelled-item-ids";

const members = (item: GateItem) => [{ slice: item.slice, head: item.head }, ...(item.group ?? [])];
const covers = (item: GateItem, slice: string, head: string) => members(item).some((m) => m.slice === slice && m.head === head);
const overlaps = (a: GateItem, b: GateItem) => members(a).some((x) => members(b).some((y) => x.slice === y.slice));

export class Gate extends DurableObject<Env> {
	/** Queue a slice's approved commit. A newer item for the same slices replaces an older one. */
	async enqueue(taskId: string, item: GateItem) {
		const queued = (await this.ctx.storage.get<GateItem[]>("queue")) ?? [];
		const current = await this.ctx.storage.get<GateItem>("current");
		const replaced = queued.filter((q) => q.id !== current?.id && overlaps(q, item));
		const queue = queued.filter((q) => !replaced.some((r) => r.id === q.id));
		const cancelled = (await this.ctx.storage.get<string[]>(CANCELLATIONS)) ?? [];
		const replacedIds = replaced.map((q) => q.id).filter((id): id is string => !!id);
		await this.ctx.storage.put({
			taskId,
			queue: [...queue, { ...item, id: crypto.randomUUID() }],
			[CANCELLATIONS]: [...new Set([...cancelled, ...replacedIds])],
		});
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Cancel only the queued/current item containing this exact member commit. */
	async cancel(taskId: string, slice: string, head: string): Promise<void> {
		if ((await this.ctx.storage.get<string>("taskId")) !== taskId) return;
		const [queue, current, cancelled] = await Promise.all([
			this.ctx.storage.get<GateItem[]>("queue"),
			this.ctx.storage.get<GateItem>("current"),
			this.ctx.storage.get<string[]>(CANCELLATIONS),
		]);
		const queued = queue ?? [];
		const matched = queued.filter((item) => covers(item, slice, head));
		const currentMatches = !!current && current.id !== undefined && covers(current, slice, head);
		const ids = [...matched.map((item) => item.id), ...(currentMatches ? [current!.id] : [])].filter((id): id is string => !!id);
		const nextQueue = queued.filter((item) => !matched.some((match) => match.id === item.id));
		const updates: Record<string, unknown> = {
			queue: nextQueue,
			[CANCELLATIONS]: [...new Set([...(cancelled ?? []), ...ids])],
		};
		if (currentMatches) updates.current = { ...current!, cancelled: true };
		await this.ctx.storage.put(updates);
		if (nextQueue.length) await this.ctx.storage.setAlarm(Date.now());
	}

	async state() {
		const [queue, current] = await Promise.all([this.ctx.storage.get<GateItem[]>("queue"), this.ctx.storage.get<GateItem>("current")]);
		return { queue: queue ?? [], current: current ?? null };
	}

	/** Whether this exact queue item still exists and has not been cancelled/replaced. */
	private async itemIsLive(item: GateItem) {
		const [queue, cancelled] = await Promise.all([
			this.ctx.storage.get<GateItem[]>("queue"),
			this.ctx.storage.get<string[]>(CANCELLATIONS),
		]);
		return !!item.id && (queue ?? []).some((queued) => queued.id === item.id) && !(cancelled ?? []).includes(item.id);
	}

	/** Drop only this run's item/current marker, never a newer item for the same slice. */
	private async finishItem(item: GateItem) {
		const [queue, current] = await Promise.all([
			this.ctx.storage.get<GateItem[]>("queue"),
			this.ctx.storage.get<GateItem>("current"),
		]);
		const rest = (queue ?? []).filter((q) => q.id !== item.id);
		await this.ctx.storage.put("queue", rest);
		if (current?.id === item.id) await this.ctx.storage.delete("current");
		if (rest.length) await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		const taskId = await this.ctx.storage.get<string>("taskId");
		const queue = (await this.ctx.storage.get<GateItem[]>("queue")) ?? [];
		const item = queue[0];
		if (!taskId || !item) return;

		// A cancellation can race the initial queue read. Check before claiming,
		// then again after writing current so a cancellation in that gap is seen.
		if (!(await this.itemIsLive(item))) return;
		await this.ctx.storage.put("current", item);
		try {
			if (!(await this.itemIsLive(item))) return;
			// The task's leader, if it's elected; its Coordinator object otherwise.
			const coordinator = taskCoordinator(this.env, taskId);
			const plan = await coordinator.gatePlan(item.slice, item.head, item.group);
			// gatePlan may wait on Coordinator I/O while a send-back cancels the item.
			if (!plan || !(await this.itemIsLive(item))) return;

			let result: GateResult;
			try {
				result = await this.check(item, plan);
			} catch (err) {
				// A gate that couldn't run counts as a failure the Coordinator can explain.
				const { message } = statusOf(err);
				result = { passed: false, head: item.head, baseHead: plan.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: message }], at: new Date().toISOString() };
				await this.ctx.storage.delete("prepared"); // start from a fresh checkout next time
			}
			// A veto may arrive while checks are running; never report that stale result.
			if (await this.itemIsLive(item)) await coordinator.gateResult(item.slice, result, plan.exclude, item.group);
		} finally {
			await this.finishItem(item);
		}
	}

	private async check(item: GateItem, plan: GatePlan): Promise<GateResult> {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for Gate");
		const result = (partial: Partial<GateResult>): GateResult => ({
			passed: false,
			head: item.head,
			baseHead: plan.baseHead,
			results: [],
			at: new Date().toISOString(),
			...partial,
		});

		// Reuse the checkout (and its installed dependencies) while the container lives.
		if (!container.running || !(await this.ctx.storage.get<boolean>("prepared"))) {
			await bootContainer(container);
			await run(container, ["rm", "-rf", WORKDIR], "/");
			const clone = await gitWithToken(container, plan.base.token, ["clone", "--quiet", plan.base.remote, WORKDIR], "/");
			if (clone.exitCode !== 0) throw new Error(`clone of the task base failed: ${clip(clone.output, 2_000)}`);
			await this.ctx.storage.delete("lockHash");
			await this.ctx.storage.put("prepared", true);
		}
		await container.setInactivityTimeout(10 * 60_000);

		const base = await gitWithToken(container, plan.base.token, ["fetch", "-q", plan.base.remote, "main:refs/remotes/base/main", "--force"]);
		if (base.exitCode !== 0) throw new Error(`fetch of the task base failed: ${clip(base.output, 2_000)}`);
		// Fetch the fork's main (fetching a bare commit hash depends on server settings);
		// the approved commit is in its history.
		const fork = await gitWithToken(container, plan.fork.token, ["fetch", "-q", plan.fork.remote, "main:refs/remotes/slice/main", "--force"]);
		if (fork.exitCode !== 0) throw new Error(`fetch of the slice failed: ${clip(fork.output, 2_000)}`);
		const known = await run(container, ["git", "cat-file", "-e", `${item.head}^{commit}`]);
		if (known.exitCode !== 0) throw new Error(`the approved commit ${item.head} is not in the slice's fork`);
		for (const other of plan.others) {
			const f = await gitWithToken(container, other.token, ["fetch", "-q", other.remote, `main:refs/remotes/${other.slice}/main`, "--force"]);
			if (f.exitCode !== 0) throw new Error(`fetch of ${other.slice} failed: ${clip(f.output, 2_000)}`);
		}

		// A clean checkout of the base; ignored files (node_modules) survive `git clean -fd`.
		await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${plan.baseHead} && git clean -fdq`]);
		// Merge the slice, then any other slices in its group, onto the base.
		for (const head of [item.head, ...plan.others.map((o) => o.head)]) {
			const merge = await run(container, ["git", "-c", "user.name=gate", "-c", "user.email=gate@blueprint.invalid", "merge", "-q", "--no-edit", head]);
			if (merge.exitCode !== 0) {
				const conflicts = await run(container, ["git", "diff", "--name-only", "--diff-filter=U"]);
				await run(container, ["git", "merge", "--abort"]);
				return result({ mergeConflict: conflicts.output.split("\n").filter(Boolean) });
			}
		}
		if (plan.exclude.length) await run(container, ["rm", "-f", "--", ...plan.exclude]);

		// Checks run on a fresh checkout. If none installs dependencies but the
		// project has a lockfile, install them first, or every check fails on
		// missing tools (planners sometimes leave the install step out).
		const checks = [...plan.checks];
		if (!checks.some((c) => INSTALL.test(c.trim())) && (await run(container, ["test", "-f", "package-lock.json"])).exitCode === 0) checks.unshift("npm ci");

		const results = [];
		for (const command of checks) {
			if (INSTALL.test(command.trim()) && (await this.installUnchanged(container))) {
				results.push({ command, exitCode: 0, output: "Skipped: package-lock.json is unchanged since the last install in this gate." });
				continue;
			}
			const r = await run(container, ["bash", "-lc", command], WORKDIR, undefined, 600);
			results.push({ command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
			if (INSTALL.test(command.trim())) await this.ctx.storage.put("lockHash", await this.lockHash(container));
		}
		return result({ passed: results.length === checks.length && results.every((r) => r.exitCode === 0), results });
	}

	private async lockHash(container: Container) {
		const r = await run(container, ["bash", "-lc", "sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1"]);
		return r.output.trim();
	}

	/** Dependencies are installed and the lockfile matches the last install. */
	private async installUnchanged(container: Container) {
		const last = await this.ctx.storage.get<string>("lockHash");
		if (!last) return false;
		const installed = await run(container, ["test", "-d", "node_modules"]);
		return installed.exitCode === 0 && (await this.lockHash(container)) === last;
	}
}
