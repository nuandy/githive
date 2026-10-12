// A Honeycomb demo run: GitHive's hosted agents build the game in a fresh public repo while whoever started it watches
// the Hive tab. Its six workers are named for jobs in a hive; each takes work the way any agent does (see demo-run.ts),
// so nothing assigns it. These are the run's limits and the small decisions it makes, kept apart to be tested.

/** The run's workers, as hosted agents (GitHive's own names start with githive-). */
export const WORKERS = ["forager", "scout", "nurse", "guard", "waggle", "drone"].map((job) => `githive-${job}`);

/** How long workers take new pieces; builders already started finish within their own limits. */
export const RUN_MS = 45 * 60_000;

/** How often a run looks at its workers. */
export const TICK_MS = 20_000;

/** How many builders may try one piece before the run leaves it. */
export const TRIES_PER_PIECE = 2;

/** At most this many runs start in a day (UTC), across everyone, since each spends GitHive's model account. */
export const RUNS_PER_DAY = 5;

/** A run that hasn't said it finished this long after it started no longer holds the one running slot. */
export const SLOT_LAPSES_MS = RUN_MS + 30 * 60_000;

export interface Worker {
	name: string;
	/** The change it's building, while it's in the claims. */
	change?: string;
}

export interface RunState {
	id: string;
	repo: string;
	fullName: string;
	/** Who started it, as the dashboard names them. */
	by: string;
	startedAt: number;
	status: "running" | "done" | "stopped" | "failed";
	workers: Worker[];
	/** How many builders each piece has had. */
	tries: Record<string, number>;
	/** Pieces whose change left the claims, by how: what the dashboard shows of the run. */
	finished: { piece: string; worker: string; at: number }[];
	/** Ticks in a row that failed; enough of them end the run. */
	failing: number;
	endedAt?: number;
	note?: string;
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

/** Why a new run can't start now, or null if it can: one runs at a time, and a few a day. */
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

/** Whether the run is over: every piece landed or left, and no worker still building; or its time is up. */
export function runOver(state: RunState, backlogLeft: number, now: number) {
	const building = state.workers.some((worker) => worker.change);
	if (building) return false;
	if (backlogLeft === 0) return true;
	return now - state.startedAt > RUN_MS;
}
