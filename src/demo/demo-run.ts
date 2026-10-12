import { DurableObject } from "cloudflare:workers";
import { statusOf } from "../errors";
import type { HostedAgent } from "../hosted-agents";
import { callTool } from "../toolkit/mcp";
import { DEMO_AGENT, demoContext, gatesOf, setUpRun } from "./demo-repo";
import {
	type Gates,
	type Registry,
	type RunSlot,
	type RunState,
	DEMO_AGENTS,
	RUN_MINUTES,
	RESET_WATCH_MS,
	WATCH_MS,
	ended,
	nextRun,
	refusal,
	runEnding,
	started,
} from "./run";

// Honeycomb demo runs (see run.ts), one class in two parts by instance name:
// - "registry" holds the limits: one run at a time, up to 100 a day.
// - "run:<id>" sets the demo repo up for the run, starts GitHive's hosted agents on it and watches them, to say how
//   the run is going and when it's over. They're the same agents anyone can add to a repo, and nothing here tells
//   them what to do. A run that starts with a reset (see demo-repo.ts) merges it first, puts the repo's approvals
//   back, and only then starts them. All of it happens here, on the run's own alarm, not in the request that asked
//   for the run, so a request cut short leaves nothing half done.

const EMPTY_REGISTRY: Registry = { day: { date: "", started: 0 }, recent: [] };

export class DemoRun extends DurableObject<Env> {
	// The registry.

	/**
	 * Takes the running slot for a new run, numbering it, or says why it can't start. A slot whose run never began, its
	 * request having failed before it could, holds nothing.
	 */
	async reserve(input: Pick<RunSlot, "fullName" | "since">): Promise<{ refused?: string; slot?: RunSlot }> {
		const kept = (await this.ctx.storage.get<Registry>("registry")) ?? EMPTY_REGISTRY;
		const holder = kept.running;
		const neverBegan = holder ? !(await this.runBegan(holder.id)) : false;
		const registry = neverBegan ? ended(kept, holder!.id) : kept;
		const reason = refusal(registry, input.since);
		if (reason) return { refused: reason };
		const number = nextRun(registry);
		const slot: RunSlot = { ...input, id: `run-${number}`, number };
		await this.ctx.storage.put("registry", started(registry, slot));
		return { slot };
	}

	/** Frees the running slot once run `id` has ended (or never got going). */
	async release(id: string) {
		const registry = (await this.ctx.storage.get<Registry>("registry")) ?? EMPTY_REGISTRY;
		await this.ctx.storage.put("registry", ended(registry, id));
	}

	/** The run going now, if any, and the latest ones. */
	async runs() {
		return (await this.ctx.storage.get<Registry>("registry")) ?? EMPTY_REGISTRY;
	}

	/** Whether run `id` began (tests answer it instead). */
	protected async runBegan(id: string) {
		return this.env.DEMO_RUN.getByName(`run:${id}`).began();
	}

	// A run.

	/** Whether this run has begun. */
	async began() {
		return !!(await this.ctx.storage.get<RunState>("run"));
	}

	/** Begins a run: it sets the demo repo up on its own alarm, at once, then starts its agents. */
	async begin(input: Pick<RunState, "id" | "number" | "repo" | "fullName" | "by">) {
		const startedAt = Date.now();
		await this.ctx.storage.put("run", { ...input, startedAt, status: "running", settingUp: true } satisfies RunState);
		await this.ctx.storage.setAlarm(startedAt);
	}

	/** Sets the demo repo up for `run`, given the settings to put back after its reset (tests answer it instead). */
	protected setUp(run: RunState, restore: () => Promise<Gates>): Promise<Pick<RunState, "repo" | "reset" | "restore">> {
		return setUpRun(this.env, run.number, restore);
	}

	/**
	 * The repo's approvals and checks before this run changed them: read once and kept with the run before the reset
	 * turns them off, so a setup that's cut short and runs again puts back what the repo had, not the reset's.
	 */
	private async keptGates(run: RunState): Promise<Gates> {
		const kept = (await this.ctx.storage.get<RunState>("run"))?.restore;
		if (kept) return kept;
		const restore = await this.currentGates(run.repo);
		await this.ctx.storage.put("run", { ...run, restore } satisfies RunState);
		return restore;
	}

	/** The repo's approvals and checks now (tests answer it instead). */
	protected currentGates(repo: string): Promise<Gates> {
		return gatesOf(this.env, repo);
	}

	/** Sets the repo up, then starts the agents, or waits for the reset; a run that can't be set up has failed. */
	private async setUpThenStart(run: RunState) {
		try {
			const { settingUp: _, ...rest } = run;
			const ready: RunState = { ...rest, ...(await this.setUp(run, () => this.keptGates(run))) };
			await this.ctx.storage.put("run", ready);
			if (!ready.reset) await this.startAgents(ready);
			await this.ctx.storage.setAlarm(Date.now() + this.watchEvery(ready));
		} catch (err) {
			const error = statusOf(err).message;
			console.error(`demo ${run.id}: setting up failed`, error);
			const failed: RunState = { ...((await this.ctx.storage.get<RunState>("run")) ?? run), status: "failed", error };
			// The reset may have turned the repo's approvals and checks off already: put them back.
			if (failed.restore) await this.callTool("settings", { repo: run.repo, ...failed.restore }).catch(() => undefined);
			await this.ctx.storage.put("run", { ...failed, endedAt: Date.now() });
			await this.env.DEMO_RUN.getByName("registry").release(run.id);
		}
	}

	private startAgents(run: RunState) {
		return this.hiveOf(run.repo).start({ repo: run.repo, count: DEMO_AGENTS, minutes: RUN_MINUTES, by: run.by });
	}

	/** A reset lands within a minute or two, so a run waiting on one looks more often. */
	private watchEvery(run: RunState) {
		return run.reset ? RESET_WATCH_MS : WATCH_MS;
	}

	/** Where the run stands, with each agent's own account, for the dashboard. */
	async status() {
		const run = await this.ctx.storage.get<RunState>("run");
		if (!run) return null;
		const agentsStarted = !run.settingUp && !run.reset;
		if (!agentsStarted) return { ...run, agents: [] };
		const hive = await this.hiveOf(run.repo).status();
		return { ...run, agents: hive?.agents ?? [] };
	}

	/** The repo's hosted agents (tests stand in for them). */
	protected hiveOf(repo: string): Pick<HostedAgent, "start" | "status" | "stopAll"> {
		return this.env.HOSTED_AGENT.getByName(`hive:${repo}`);
	}

	/** A toolkit call as the demo's own agent (tests answer them instead). */
	protected callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		return callTool(name, { agent: DEMO_AGENT, ...args }, demoContext(this.env));
	}

	/** The run's look at its agents: it's over once every agent has stopped, or long past its time. */
	async alarm() {
		const stored = await this.ctx.storage.get<RunState>("run");
		if (stored?.status !== "running") return;
		if (stored.settingUp) return this.setUpThenStart(stored);
		const run = stored.reset ? await this.settleReset(stored) : stored;
		const hive = await this.hiveOf(run.repo).status();
		const ending = runEnding(run, hive?.agents ?? [], Date.now());
		if (!ending) {
			await this.ctx.storage.put("run", run);
			return this.ctx.storage.setAlarm(Date.now() + this.watchEvery(run));
		}
		if (ending === "stopped") await this.stopRun(run);
		await this.ctx.storage.put("run", { ...run, status: ending, endedAt: Date.now() } satisfies RunState);
		await this.env.DEMO_RUN.getByName("registry").release(run.id);
	}

	/** Stops a run past its time: its agents, and a reset that never landed, giving the repo its approvals back. */
	private async stopRun(run: RunState) {
		await this.hiveOf(run.repo).stopAll();
		if (run.reset && run.restore) await this.callTool("settings", { repo: run.repo, ...run.restore });
	}

	/**
	 * Merges the run's reset, which needs no approval; once it has left the claims, puts the repo's approvals back and
	 * starts the agents. A step that fails is tried again at the next look.
	 */
	private async settleReset(run: RunState): Promise<RunState> {
		const change = run.reset!;
		try {
			const status = (await this.callTool("status", { repo: run.repo, change })) as { claim?: unknown };
			if (status.claim) {
				await this.callTool("merge", { repo: run.repo, change });
				return run;
			}
			if (run.restore) await this.callTool("settings", { repo: run.repo, ...run.restore });
			await this.startAgents(run);
			const { reset: _, restore: __, ...rest } = run;
			return rest;
		} catch (err) {
			console.error(`demo ${run.id}: settling its reset failed`, statusOf(err).message);
			return run;
		}
	}
}
