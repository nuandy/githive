// A Honeycomb demo run: GitHive's hosted agents (see hosted-agents.ts) build the game in a fresh public repo while
// whoever started it watches the Hive tab. These are the run's limits and the small decisions it makes, kept apart to
// be tested.

/** How many of GitHive's hosted agents a run starts. */
export const DEMO_AGENTS = 6;

/** How long agents take new pieces; a builder or review already started finishes within its own limits. */
export const RUN_MINUTES = 45;

/** How often the run looks at its agents. */
export const WATCH_MS = 60_000;

/** Past this, a run whose agents haven't all stopped is stopped. */
export const RUN_GIVES_UP_MS = (RUN_MINUTES + 30) * 60_000;

/** At most this many runs start in a day (UTC), across everyone, since each spends GitHive's model account. */
export const RUNS_PER_DAY = 100;

/** A run that hasn't said it finished this long after it started no longer holds the one running slot. */
export const SLOT_LAPSES_MS = RUN_GIVES_UP_MS + 5 * 60_000;

export interface RunState {
	id: string;
	repo: string;
	fullName: string;
	/** Who started it, as the dashboard names them. */
	by: string;
	startedAt: number;
	status: "running" | "done" | "stopped";
	endedAt?: number;
}

export interface RunSlot {
	id: string;
	fullName: string;
	since: number;
}

export interface Registry {
	running?: RunSlot;
	/** Runs started on each UTC day, by date; only today's is kept. */
	day: { date: string; started: number };
	/** The latest runs, newest first. */
	recent: RunSlot[];
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Why a new run can't start now, or null if it can: one runs at a time, and up to 100 a day. */
export function refusal(registry: Registry, now: number): string | null {
	const running = registry.running && now - registry.running.since < SLOT_LAPSES_MS ? registry.running : undefined;
	if (running) return `a demo run is going already: watch it at ${running.fullName}`;
	const today = registry.day.date === dayOf(now) ? registry.day.started : 0;
	if (today >= RUNS_PER_DAY) return `today's ${RUNS_PER_DAY} demo runs have happened: come back tomorrow (UTC)`;
	return null;
}

/** The registry with a run started now. */
export function started(registry: Registry, slot: RunSlot): Registry {
	const date = dayOf(slot.since);
	const before = registry.day.date === date ? registry.day.started : 0;
	return {
		running: slot,
		day: { date, started: before + 1 },
		recent: [slot, ...registry.recent.filter((run) => run.id !== slot.id)].slice(0, 20),
	};
}

/** The registry once run `id` has ended, freeing the slot if it held it. */
export function ended(registry: Registry, id: string): Registry {
	if (registry.running?.id !== id) return registry;
	const { running: _, ...rest } = registry;
	return rest;
}

/** A demo repo's name: honeycomb and when it started, unique enough for a handful a day. */
export function repoName(now: number) {
	const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "");
	return `honeycomb-${stamp}`;
}

/** How a run ends, if it has: done once every agent has stopped, stopped once it's long past its time. */
export function runEnding(run: RunState, agents: { done: boolean }[], now: number): "done" | "stopped" | null {
	if (agents.length && agents.every((agent) => agent.done)) return "done";
	if (now - run.startedAt > RUN_GIVES_UP_MS) return "stopped";
	return null;
}
