import { DurableObject } from "cloudflare:workers";
import { statusOf } from "../errors";
import type { HostedAgent } from "../hosted-agents";
import { callTool } from "../toolkit/mcp";
import { DEMO_AGENT, demoContext } from "./demo-repo";
import {
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
// - "run:<id>" starts GitHive's hosted agents on the demo repo and watches them, to say how the run is going and when
//   it's over. They're the same agents anyone can add to a repo, and nothing here tells them what to do. A run that
//   starts with a reset (see demo-repo.ts) merges it first, puts the repo's approvals back, and only then starts them.

const EMPTY_REGISTRY: Registry = { day: { date: "", started: 0 }, recent: [] };

export class DemoRun extends DurableObject<Env> {
	// The registry.

	/** Takes the running slot for a new run, numbering it, or says why it can't start. */
	async reserve(input: Pick<RunSlot, "fullName" | "since">): Promise<{ refused?: string; slot?: RunSlot }> {
		const registry = (await this.ctx.storage.get<Registry>("registry")) ?? EMPTY_REGISTRY;
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

	// A run.

	/** Starts a run on a repo that's set up already: its agents now, or once its reset has landed. */
	async begin(input: Pick<RunState, "id" | "number" | "repo" | "fullName" | "by" | "reset" | "required">) {
		const startedAt = Date.now();
		const run: RunState = { ...input, startedAt, status: "running" };
		await this.ctx.storage.put("run", run);
		if (!run.reset) await this.startAgents(run);
		await this.ctx.storage.setAlarm(startedAt + this.watchEvery(run));
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
		if (run.reset) return { ...run, agents: [] };
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
		if (run.reset && run.required !== undefined)
			await this.callTool("settings", { repo: run.repo, required: run.required });
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
			if (run.required !== undefined) await this.callTool("settings", { repo: run.repo, required: run.required });
			await this.startAgents(run);
			const { reset: _, required: __, ...rest } = run;
			return rest;
		} catch (err) {
			console.error(`demo ${run.id}: settling its reset failed`, statusOf(err).message);
			return run;
		}
	}
}
