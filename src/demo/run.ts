// A Honeycomb demo run: GitHive's hosted agents (see hosted-agents.ts) build the game in the one public demo repo
// while whoever started it watches its Hive tab. Each run puts the starting files back first, as a change of its own,
// then builds the game again on top, so the repo's history holds every run. These are the run's limits and
// the small decisions it makes, kept apart to be tested.

import type { DemoPiece } from "./backlog";

/** How many of GitHive's hosted agents a run starts. */
// Enough for every piece that waits on nothing to be taken at once. It adds no builds or reviews, so it costs no more.
export const DEMO_AGENTS = 12;

/** How long agents take new pieces; a builder or review already started finishes within its own limits. */
export const RUN_MINUTES = 45;

/** How often the run looks at its agents. */
export const WATCH_MS = 60_000;

/** How often a run waiting on its reset looks at it. */
export const RESET_WATCH_MS = 15_000;

/** Past this, a run whose agents haven't all stopped is stopped. */
export const RUN_GIVES_UP_MS = (RUN_MINUTES + 30) * 60_000;

/** At most this many runs start in a day (UTC), across everyone, since each spends GitHive's model account. */
export const RUNS_PER_DAY = 100;

/** A run that hasn't said it finished this long after it started no longer holds the one running slot. */
export const SLOT_LAPSES_MS = RUN_GIVES_UP_MS + 5 * 60_000;

export interface RunState {
	id: string;
	/** Its place among all runs, which names its changes. */
	number: number;
	/** The change that puts the starting files back, until it lands; a repo's first run needs none. */
	reset?: string;
	/** The approvals the repo required before the reset, put back once it lands, before the agents start. */
	required?: number;
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
	number: number;
	fullName: string;
	since: number;
}

export interface Registry {
	running?: RunSlot;
	/** Runs started on each UTC day, by date; only today's is kept. */
	day: { date: string; started: number };
	/** The latest runs, newest first. */
	recent: RunSlot[];
	/** Runs ever started. */
	total?: number;
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
		total: slot.number,
	};
}

/** The registry once run `id` has ended, freeing the slot if it held it. */
export function ended(registry: Registry, id: string): Registry {
	if (registry.running?.id !== id) return registry;
	const { running: _, ...rest } = registry;
	return rest;
}

/** The next run's number. */
export const nextRun = (registry: Registry) => (registry.total ?? 0) + 1;

/** The change that puts run `number`'s starting files back. */
export const resetChange = (number: number) => `reset-${number}`;

/**
 * The backlog for run `number`: its pieces, with ids of their own, since a piece's id is the change that builds it and
 * a change that merged in an earlier run would count this run's piece as done.
 */
export function runBacklog(pieces: DemoPiece[], number: number) {
	const own = (id: string) => `${id}-${number}`;
	return pieces.map(({ id, title, intent, paths, after }) => ({
		id: own(id),
		title,
		intent,
		paths,
		...(after ? { after: after.map(own) } : {}),
	}));
}

/** How a run ends, if it has: done once every agent it started has stopped, stopped once it's long past its time. */
export function runEnding(run: RunState, agents: { done: boolean }[], now: number): "done" | "stopped" | null {
	// Until its reset lands its agents haven't started, and the hive still lists the last run's.
	const started = !run.reset;
	if (started && agents.length && agents.every((agent) => agent.done)) return "done";
	if (now - run.startedAt > RUN_GIVES_UP_MS) return "stopped";
	return null;
}
