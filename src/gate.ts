import { DurableObject } from "cloudflare:workers";
import { WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import type { GateResult } from "./gate-plan";

// The integration gate ("semantic Merge-ahead"). Before an approved slice is
// integrated, a Gate merges it onto the current task base in its own
// container and runs the task's checks on the combined code. Text conflicts
// are caught on every push; this catches changes that merge cleanly but
// break together. No model is involved: it's a build, run from an alarm.

export interface GateJob {
	taskId: string;
	slice: string;
	/** The approved slice commit, and the task base commit to merge it onto. */
	head: string;
	baseHead: string;
	base: { remote: string; token: string };
	fork: { remote: string; token: string };
	checks: string[];
	/** Contract test files to remove first (their slices aren't integrated yet). */
	exclude: string[];
}

interface GateState {
	status: "running" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	result?: GateResult;
	error?: string;
}

export class Gate extends DurableObject<Env> {
	async start(job: GateJob) {
		const state = await this.ctx.storage.get<GateState>("state");
		if (state?.status === "running") return state;
		const fresh: GateState = { status: "running", startedAt: new Date().toISOString() };
		await this.ctx.storage.put({ job, state: fresh });
		await this.ctx.storage.setAlarm(Date.now());
		return fresh;
	}

	async state() {
		return (await this.ctx.storage.get<GateState>("state")) ?? null;
	}

	async alarm() {
		const job = await this.ctx.storage.get<GateJob>("job");
		const state = await this.ctx.storage.get<GateState>("state");
		if (!job || state?.status !== "running") return;
		try {
			state.result = await this.check(job);
			state.status = "done";
		} catch (err) {
			state.status = "failed";
			state.error = err instanceof Error ? err.message : String(err);
		}
		state.finishedAt = new Date().toISOString();
		await this.ctx.storage.put("state", state);
		if (this.ctx.container?.running) await this.ctx.container.destroy("gate finished");

		// Report back. A gate that couldn't run counts as a failure the Coordinator can explain.
		const result: GateResult = state.result ?? {
			passed: false,
			head: job.head,
			baseHead: job.baseHead,
			results: [{ command: "(gate setup)", exitCode: 1, output: state.error ?? "unknown error" }],
			at: state.finishedAt,
		};
		const coordinator = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(job.taskId));
		await coordinator.gateResult(job.slice, result, job.exclude);
	}

	private async check(job: GateJob): Promise<GateResult> {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for Gate");
		const result = (partial: Partial<GateResult>): GateResult => ({
			passed: false,
			head: job.head,
			baseHead: job.baseHead,
			results: [],
			at: new Date().toISOString(),
			...partial,
		});
		await bootContainer(container);
		await container.setInactivityTimeout(20 * 60_000);

		const clone = await gitWithToken(container, job.base.token, ["clone", "--quiet", job.base.remote, WORKDIR], "/");
		if (clone.exitCode !== 0) throw new Error(`clone of the task base failed: ${clip(clone.output, 2_000)}`);
		await run(container, ["git", "checkout", "-q", job.baseHead]);
		// Fetch the fork's main (fetching a bare commit hash depends on server settings);
		// the approved commit is in its history.
		const fetch = await gitWithToken(container, job.fork.token, ["fetch", "-q", job.fork.remote, "main:refs/remotes/slice/main"]);
		if (fetch.exitCode !== 0) throw new Error(`fetch of the slice failed: ${clip(fetch.output, 2_000)}`);
		const known = await run(container, ["git", "cat-file", "-e", `${job.head}^{commit}`]);
		if (known.exitCode !== 0) throw new Error(`the approved commit ${job.head} is not in the slice's fork`);

		const merge = await run(container, ["git", "-c", "user.name=gate", "-c", "user.email=gate@blueprint.invalid", "merge", "-q", "--no-edit", job.head]);
		if (merge.exitCode !== 0) {
			const conflicts = await run(container, ["git", "diff", "--name-only", "--diff-filter=U"]);
			return result({ mergeConflict: conflicts.output.split("\n").filter(Boolean) });
		}
		if (job.exclude.length) await run(container, ["rm", "-f", "--", ...job.exclude]);

		const results = [];
		for (const command of job.checks) {
			const r = await run(container, ["bash", "-lc", command], WORKDIR, undefined, 600);
			results.push({ command, exitCode: r.exitCode, output: clip(r.output, 6_000) });
			if (r.exitCode !== 0) break; // later checks usually depend on earlier ones (npm ci first)
		}
		return result({ passed: results.length === job.checks.length && results.every((r) => r.exitCode === 0), results });
	}
}
