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
//   it's over. They're the same agents anyone can add to a repo, and nothing here tells them what to do. It also
//   merges the run's reset once the hive approves it (see demo-repo.ts).

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

	/** Starts a run's agents on a repo that's set up already: its files, settings and backlog. */
	async begin(input: Pick<RunState, "id" | "number" | "repo" | "fullName" | "by" | "reset">) {
		const startedAt = Date.now();
		await this.ctx.storage.put("run", { ...input, startedAt, status: "running" } satisfies RunState);
		const hive = { repo: input.repo, count: DEMO_AGENTS, minutes: RUN_MINUTES, by: input.by };
		await this.hiveOf(input.repo).start(hive);
		await this.ctx.storage.setAlarm(startedAt + WATCH_MS);
	}

	/** Where the run stands, with each agent's own account, for the dashboard. */
	async status() {
		const run = await this.ctx.storage.get<RunState>("run");
		if (!run) return null;
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
			return this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
		}
		if (ending === "stopped") await this.hiveOf(run.repo).stopAll();
		await this.ctx.storage.put("run", { ...run, status: ending, endedAt: Date.now() } satisfies RunState);
		await this.env.DEMO_RUN.getByName("registry").release(run.id);
	}

	/** Merges the run's reset once approved; once it's out of the claims, the run has no reset to wait on. */
	private async settleReset(run: RunState): Promise<RunState> {
		const change = run.reset!;
		try {
			const status = (await this.callTool("status", { repo: run.repo, change })) as {
				claim?: unknown;
				approval?: { approved?: boolean };
			};
			if (!status.claim) {
				const { reset: _, ...rest } = run;
				return rest;
			}
			if (status.approval?.approved) await this.callTool("merge", { repo: run.repo, change });
		} catch (err) {
			console.error(`demo ${run.id}: settling its reset failed`, statusOf(err).message);
		}
		return run;
	}
}
