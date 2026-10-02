import { DurableObject } from "cloudflare:workers";
import { WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
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
	slice: string;
	/** The approved commit to check. */
	head: string;
}

/** What the Coordinator hands a run when it starts. */
export interface GatePlan {
	baseHead: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string };
	checks: string[];
	/** Contract test files to remove first (their slices aren't integrated yet). */
	exclude: string[];
}

const INSTALL = /^npm ci(\s|$)/;

export class Gate extends DurableObject<Env> {
	/** Queue a slice's approved commit. A newer commit for the same slice replaces an older one. */
	async enqueue(taskId: string, item: GateItem) {
		const queue = ((await this.ctx.storage.get<GateItem[]>("queue")) ?? []).filter((q) => q.slice !== item.slice);
		await this.ctx.storage.put({ taskId, queue: [...queue, item] });
		await this.ctx.storage.setAlarm(Date.now());
	}

	async state() {
		const [queue, current] = await Promise.all([this.ctx.storage.get<GateItem[]>("queue"), this.ctx.storage.get<GateItem>("current")]);
		return { queue: queue ?? [], current: current ?? null };
	}

	async alarm() {
		const taskId = await this.ctx.storage.get<string>("taskId");
		const queue = (await this.ctx.storage.get<GateItem[]>("queue")) ?? [];
		const item = queue[0];
		if (!taskId || !item) return;
		await this.ctx.storage.put("current", item);
		const coordinator = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(taskId));

		const plan = await coordinator.gatePlan(item.slice, item.head);
		if (plan) {
			let result: GateResult;
			try {
				result = await this.check(item, plan);
			} catch (err) {
				// A gate that couldn't run counts as a failure the Coordinator can explain.
				const message = err instanceof Error ? err.message : String(err);
				result = { passed: false, head: item.head, baseHead: plan.baseHead, results: [{ command: "(gate setup)", exitCode: 1, output: message }], at: new Date().toISOString() };
				await this.ctx.storage.delete("prepared"); // start from a fresh checkout next time
			}
			await coordinator.gateResult(item.slice, result, plan.exclude);
		}

		// Done with this item (a newer one for the same slice may have replaced it meanwhile).
		const latest = (await this.ctx.storage.get<GateItem[]>("queue")) ?? [];
		const rest = latest.filter((q) => !(q.slice === item.slice && q.head === item.head));
		await this.ctx.storage.put("queue", rest);
		await this.ctx.storage.delete("current");
		if (rest.length) await this.ctx.storage.setAlarm(Date.now());
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

		// A clean checkout of the base; ignored files (node_modules) survive `git clean -fd`.
		await run(container, ["bash", "-lc", `git merge --abort 2>/dev/null; git checkout -q -f --detach ${plan.baseHead} && git clean -fdq`]);
		const merge = await run(container, ["git", "-c", "user.name=gate", "-c", "user.email=gate@blueprint.invalid", "merge", "-q", "--no-edit", item.head]);
		if (merge.exitCode !== 0) {
			const conflicts = await run(container, ["git", "diff", "--name-only", "--diff-filter=U"]);
			await run(container, ["git", "merge", "--abort"]);
			return result({ mergeConflict: conflicts.output.split("\n").filter(Boolean) });
		}
		if (plan.exclude.length) await run(container, ["rm", "-f", "--", ...plan.exclude]);

		const results = [];
		for (const command of plan.checks) {
			if (INSTALL.test(command.trim()) && (await this.installUnchanged(container))) {
				results.push({ command, exitCode: 0, output: "Skipped: package-lock.json is unchanged since the last install in this gate." });
				continue;
			}
			const r = await run(container, ["bash", "-lc", command], WORKDIR, undefined, 600);
			results.push({ command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
			if (INSTALL.test(command.trim())) await this.ctx.storage.put("lockHash", await this.lockHash(container));
		}
		return result({ passed: results.length === plan.checks.length && results.every((r) => r.exitCode === 0), results });
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
