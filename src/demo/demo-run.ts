import { DurableObject } from "cloudflare:workers";
import type { HostedAgent } from "../hosted-agents";
import { toolContextFor } from "../toolkit/env";
import {
	type Registry,
	type RunSlot,
	type RunState,
	DEMO_AGENTS,
	RUN_MINUTES,
	WATCH_MS,
	ended,
	refusal,
	runEnding,
	started,
} from "./run";

// Honeycomb demo runs (see run.ts), one class in two parts by instance name:
// - "registry" holds the limits: one run at a time, a few a day.
// - "run:<id>" starts GitHive's hosted agents on the run's repo and watches them, to say how the run is going and when
//   it's over. They're the same agents anyone can add to a repo, and nothing here tells them what to do.

const EMPTY_REGISTRY: Registry = { day: { date: "", started: 0 }, recent: [] };

/** The context a run's setup runs in, before its agents start. */
export const demoContext = (env: Env) => toolContextFor(env, "service:githive-demo", { hosted: true });

export class DemoRun extends DurableObject<Env> {
	// The registry.

	/** Takes the running slot for a new run, or says why it can't start. */
	async reserve(slot: RunSlot): Promise<{ refused?: string }> {
		const registry = (await this.ctx.storage.get<Registry>("registry")) ?? EMPTY_REGISTRY;
		const reason = refusal(registry, slot.since);
		if (reason) return { refused: reason };
		await this.ctx.storage.put("registry", started(registry, slot));
		return {};
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
	async begin(input: Pick<RunState, "id" | "repo" | "fullName" | "by">) {
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

	/** The run's look at its agents: it's over once every agent has stopped, or long past its time. */
	async alarm() {
		const run = await this.ctx.storage.get<RunState>("run");
		if (run?.status !== "running") return;
		const hive = await this.hiveOf(run.repo).status();
		const ending = runEnding(run, hive?.agents ?? [], Date.now());
		if (!ending) return this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
		if (ending === "stopped") await this.hiveOf(run.repo).stopAll();
		await this.ctx.storage.put("run", { ...run, status: ending, endedAt: Date.now() } satisfies RunState);
		await this.env.DEMO_RUN.getByName("registry").release(run.id);
	}
}
