import { DurableObject } from "cloudflare:workers";
import { statusOf } from "../errors";
import { callTool } from "../toolkit/mcp";
import { startHostedBuilder, toolContextFor } from "../toolkit/env";
import type { BacklogView } from "../toolkit/work";
import {
	type Registry,
	type RunSlot,
	type RunState,
	RUN_MS,
	TICK_MS,
	TRIES_PER_PIECE,
	WORKERS,
	ended,
	refusal,
	runOver,
	started,
} from "./run";

// Honeycomb demo runs (see run.ts). The instance named "registry" holds the limits: one run at a time, a few a day.
// Each run has an instance of its own ("run:<id>") that drives its workers on an alarm. A worker without a change
// looks at the backlog in its own order, claims the first piece free and starts GitHive's hosted builder on it; the
// hosted reviewers review it and it lands, or its builder gives up and releases it. Once the change is out of the
// claims, the worker looks again. Nothing here assigns work: each worker takes what it finds, as any agent does.

/** Ticks in a row that may fail before a run ends as failed. */
const FAILING_MOST = 15;

const EMPTY_REGISTRY: Registry = { day: { date: "", started: 0 }, recent: [] };

/** The identity a demo run's calls are stamped with, acting as GitHive's own hosted agents. */
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

	/** Starts this run's workers on a repo that is set up already: its files, settings and backlog. */
	async begin(input: Pick<RunState, "id" | "repo" | "fullName" | "by">) {
		const state: RunState = {
			...input,
			startedAt: Date.now(),
			status: "running",
			workers: WORKERS.map((name) => ({ name })),
			tries: {},
			finished: [],
			failing: 0,
		};
		await this.ctx.storage.put("run", state);
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Where the run stands, for the dashboard. */
	async status() {
		return (await this.ctx.storage.get<RunState>("run")) ?? null;
	}

	/** A toolkit call as the run's hosted agents (tests answer them instead). */
	protected callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		return callTool(name, args, demoContext(this.env));
	}

	/** Starts GitHive's hosted builder on a claimed change (tests note it instead). */
	protected startBuilder(repo: string, change: string): Promise<unknown> {
		return startHostedBuilder(this.env, { repo, change });
	}

	async alarm() {
		const state = await this.ctx.storage.get<RunState>("run");
		if (!state || state.status !== "running") return;
		try {
			await this.tick(state);
			state.failing = 0;
		} catch (err) {
			state.failing++;
			console.error(`demo run ${state.id}: a tick failed (${state.failing} in a row)`, statusOf(err).message);
			if (state.failing >= FAILING_MOST) await this.end(state, "failed", statusOf(err).message);
		}
		await this.ctx.storage.put("run", state);
		if (state.status === "running") await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
	}

	/** One look at every worker: note what finished, give idle workers work, and end the run when it's over. */
	private async tick(state: RunState) {
		const claims = (await this.callTool("claims", { repo: state.repo })) as { change: string }[];
		const held = new Set(claims.map((claim) => claim.change));
		const now = Date.now();
		for (const worker of state.workers) {
			if (!worker.change || held.has(worker.change)) continue;
			state.finished.push({ piece: worker.change, worker: worker.name, at: now });
			delete worker.change;
		}
		// Past its time, the run lets what's being built finish, and takes nothing new.
		const takesWork = now - state.startedAt <= RUN_MS;
		let left = 0;
		for (const worker of state.workers) {
			if (worker.change) continue;
			const backlog = (await this.callTool("backlog", { repo: state.repo, agent: worker.name })) as BacklogView;
			const open = backlog.open.filter((piece) => (state.tries[piece.id] ?? 0) < TRIES_PER_PIECE);
			left = open.length + backlog.waiting.length;
			const piece = open[0];
			if (takesWork && piece) await this.take(state, worker, piece);
		}
		if (runOver(state, left, now)) await this.end(state, left === 0 ? "done" : "stopped");
	}

	/** Claims `piece` for `worker` and starts a hosted builder on it; a refused claim waits for the next tick. */
	private async take(state: RunState, worker: RunState["workers"][number], piece: BacklogView["open"][number]) {
		const intent = piece.intent ? `${piece.title}\n\n${piece.intent}` : piece.title;
		const args = { repo: state.repo, change: piece.id, agent: worker.name, paths: piece.paths ?? [], intent };
		const claimed = (await this.callTool("claim", args)) as { ok?: boolean };
		if (claimed.ok === false) return;
		state.tries[piece.id] = (state.tries[piece.id] ?? 0) + 1;
		try {
			await this.startBuilder(state.repo, piece.id);
			worker.change = piece.id;
		} catch (err) {
			// No builder means nobody would ever push to the claim: give it up, so the piece is free again.
			console.error(`demo run ${state.id}: starting a builder on ${piece.id} failed`, statusOf(err).message);
			const release = { repo: state.repo, change: piece.id, agent: worker.name, reason: "its builder didn't start" };
			await this.callTool("release", release).catch(() => undefined);
		}
	}

	private async end(state: RunState, status: RunState["status"], note?: string) {
		state.status = status;
		state.endedAt = Date.now();
		if (note) state.note = note;
		await this.env.DEMO_RUN.getByName("registry").release(state.id);
	}
}
