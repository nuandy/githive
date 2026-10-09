import type { CasLog } from "../record-log";
import type { CheckResult, CheckRunner } from "./merge";
import { appendRecord } from "./records";

// The line merges wait in for the project's checks (a merge queue), kept as a
// record in Git like the claims and votes, written by compare-and-swap by
// whichever merge is acting. Nobody runs it.
//
// A merge joins at the end and is checked, in its own container, on the
// line's tip (main as the last merge from the line left it) with the merges
// ahead of it merged in first, all side by side. It lands right after exactly
// those (see mergeChange's awaitTurn), then moves the tip to its merge
// commit. A merge that fails, gives up or goes quiet leaves the line, and
// takes every merge behind it along: they were checked assuming it would
// land, so they check again. The line decides nothing: every merge's
// trailers say what it was tested on and after, and the audit checks that
// each landed on exactly that.

/** A merge's place in line. */
export interface LineEntry {
	/** This place: a merge that leaves and joins again gets a new one. */
	id: string;
	change: string;
	/** The commit checked: the change's pushed head. */
	head: string;
	/** The agent whose fork holds it (as changes/<change>). */
	agent: string;
	since: string;
	/** When the merge last showed it was still at it; QUIET_MS without, and it's taken to have gone. */
	active: string;
	/** Its checks: running, or passed (a merge whose checks fail leaves the line). */
	status: "checking" | "passed";
}

/** How a merge left the line. */
export type LeftHow = "landed" | "failed" | "gave up" | "went quiet" | "behind one that left";

export interface Line {
	/** The main a merge joining now is checked on: the last merge landed from the line, or main as it was when the line was empty. */
	tip: string | null;
	/** The merges in line, in landing order. */
	entries: LineEntry[];
	/** The last merges to leave, newest last. */
	left: { change: string; head: string; how: LeftHow; at: string; commit?: string }[];
}

/** The most merges in line at once: a longer line means bigger checks (each merges in everything ahead) and more to check again behind a failure. */
export const MAX_LINE = 8;
/** How long a merge in line may go without showing it's still at it. */
export const QUIET_MS = 2 * 60_000;
/** How often a merge in line shows it's still at it. */
export const HEARTBEAT_MS = 30_000;
/** How many times a merge checks again in one call because a merge ahead of it failed. */
const MAX_TRIES = 4;
const LEFT_KEPT = 20;
const AUTHOR = "githive";

const emptyLine = (): Line => ({ tip: null, entries: [], left: [] });

/**
 * Where a repo's line into a branch is kept: the project's branch's at the
 * ref it always had, another branch's beside the others (a ref can't hold
 * refs inside it, so not under that one).
 */
export const lineRef = (repo: string, branch?: string) => (branch ? `refs/notes/githive-lines/${repo}/${encodeURIComponent(branch)}` : `refs/notes/githive-line/${repo}`);

/** Take the merges from `index` on out of the line: the one there `how`, the rest because they were checked after it. */
function leaveFrom(state: Line, index: number, how: LeftHow, at: string): Line {
	if (index < 0 || index >= state.entries.length) return state;
	const gone = state.entries.slice(index).map((e, i) => ({ change: e.change, head: e.head, how: i === 0 ? how : ("behind one that left" as const), at }));
	return { ...state, entries: state.entries.slice(0, index), left: [...state.left, ...gone].slice(-LEFT_KEPT) };
}

/** The line without merges that went quiet (and the ones behind them). */
export function withoutQuiet(state: Line, now = Date.now()): Line {
	const quiet = state.entries.findIndex((e) => now - Date.parse(e.active) > QUIET_MS);
	return leaveFrom(state, quiet, "went quiet", new Date(now).toISOString());
}

/** Where a merge joining the line is checked: on `base`, after `ahead`, in order. */
export interface Place {
	id: string;
	base: string;
	ahead: LineEntry[];
}

/**
 * Join the line at the end: refused ("full") while MAX_LINE merges are in it.
 * An empty line starts from `main()`, the project's branch, read only once
 * the line is seen empty: nothing in line can land in between, where a main
 * read earlier may be behind merges that landed meanwhile. A place the same
 * change still holds (an earlier try) is given up first.
 */
export async function joinLine(log: CasLog<Line>, input: { change: string; head: string; agent: string; main: () => Promise<string | null> }, now = () => Date.now()): Promise<Place | "full"> {
	let place: Place | undefined;
	const outcome = await appendRecord<Line, "full">(log, AUTHOR, emptyLine, async (current) => {
		const at = new Date(now()).toISOString();
		let state = withoutQuiet(current, now());
		state = leaveFrom(state, state.entries.findIndex((e) => e.change === input.change), "gave up", at);
		if (state.entries.length >= MAX_LINE) return { refused: "full" };
		const base = (state.entries.length ? state.tip : null) ?? (await input.main()) ?? fail409();
		const entry: LineEntry = { id: crypto.randomUUID(), change: input.change, head: input.head, agent: input.agent, since: at, active: at, status: "checking" };
		place = { id: entry.id, base, ahead: state.entries };
		return { state: { ...state, tip: base, entries: [...state.entries, entry] }, text: `${input.change} joins the line at ${input.head.slice(0, 8)}, checked on ${base.slice(0, 8)} after ${state.entries.length} ahead` };
	});
	return outcome.ok ? place! : "full";
}

const fail409 = (): never => {
	throw new Error("[409] the project's branch is gone");
};

/** Change a merge's place in line; false if it no longer holds one. */
async function updatePlace(log: CasLog<Line>, id: string, change: (state: Line, index: number, at: string) => { state: Line; text: string }, now = () => Date.now()) {
	const outcome = await appendRecord<Line, "gone">(log, AUTHOR, emptyLine, (current) => {
		const index = current.entries.findIndex((e) => e.id === id);
		return index < 0 ? { refused: "gone" } : change(current, index, new Date(now()).toISOString());
	});
	return outcome.ok;
}

/** The merge's checks passed: it waits for its turn to land. */
export const markPassed = (log: CasLog<Line>, id: string) =>
	updatePlace(log, id, (state, i, at) => ({ state: { ...state, entries: state.entries.map((e, j) => (j === i ? { ...e, status: "passed" as const, active: at } : e)) }, text: `${state.entries[i].change}'s checks passed` }));

/** The merge is still at it. */
export const keepPlace = (log: CasLog<Line>, id: string) =>
	updatePlace(log, id, (state, i, at) => ({ state: { ...state, entries: state.entries.map((e, j) => (j === i ? { ...e, active: at } : e)) }, text: `${state.entries[i].change} is still in line` }));

/** The merge landed as `commit`: it leaves the line, and the tip moves to it (it was first in line). */
export const landedFromLine = (log: CasLog<Line>, id: string, commit: string) =>
	updatePlace(log, id, (state, i, at) => {
		const e = state.entries[i];
		return {
			state: { tip: i === 0 ? commit : state.tip, entries: state.entries.filter((_, j) => j !== i), left: [...state.left, { change: e.change, head: e.head, how: "landed" as const, at, commit }].slice(-LEFT_KEPT) },
			text: `${e.change} landed as ${commit.slice(0, 8)}`,
		};
	});

/** The merge leaves the line without landing, and the merges behind it with it. */
export const leaveLine = (log: CasLog<Line>, id: string, how: "failed" | "gave up") =>
	updatePlace(log, id, (state, i, at) => ({ state: leaveFrom(state, i, how, at), text: `${state.entries[i].change} leaves the line (${how}), with the ${state.entries.length - i - 1} behind it` }));

/** Whether the place is still held. */
export async function holdsPlace(log: CasLog<Line>, id: string) {
	return !!(await log.read())?.commit.state.entries.some((e) => e.id === id);
}

/**
 * Whose a failed check is, for a merge checked after `ahead`: its own once
 * every merge ahead has passed or landed (`"mine"`), or a merge ahead's when
 * one of them left the line, which takes this one's place too (`"theirs"`).
 * Undecided at `until`: taken to be its own.
 */
export async function failureOf(log: CasLog<Line>, id: string, ahead: LineEntry[], until: number, pollMs: number): Promise<"mine" | "theirs"> {
	for (;;) {
		const state = (await log.read())?.commit.state;
		if (!state?.entries.some((e) => e.id === id)) return "theirs";
		const settled = ahead.every((a) => state.entries.some((e) => e.id === a.id && e.status === "passed") || state.left.some((l) => l.change === a.change && l.head === a.head && l.how === "landed"));
		if (settled || Date.now() > until) return "mine";
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

export interface LineChecks {
	/** The repo's line. */
	log: CasLog<Line>;
	/** The project's branch head now. */
	main(): Promise<string | null>;
	/** Run the project's checks on `base` with `ahead` merged in first, then the change: in the change's own container. */
	check(input: { change: string; head: string; ref: string; agent: string; source?: Parameters<CheckRunner>[0]["source"]; commands: string[]; base: string; ahead: LineEntry[] }): Promise<{ passed: boolean; results: CheckResult[] }>;
	/** How long a merge waits for room in a full line (5 minutes unless set, as tests do). */
	waitMs?: number;
	pollMs?: number;
	heartbeatMs?: number;
}

/**
 * Checks in the line: join it, run the checks in the change's own container
 * on the place's main after the merges ahead, and hand mergeChange what it
 * lands after, how to tell the line it's done, and whether its place is
 * still held while it waits.
 */
export function lineCheckRunner(deps: LineChecks): CheckRunner {
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	return async ({ change, head, ref, commands, source, agent }) => {
		const until = Date.now() + (deps.waitMs ?? 5 * 60_000);
		for (let tries = 1; ; tries++) {
			let place: Place | "full";
			for (;;) {
				place = await joinLine(deps.log, { change, head, agent: agent ?? change, main: deps.main });
				if (place !== "full") break;
				if (Date.now() > until) throw new Error(`[503] the line of merges stayed full (${MAX_LINE} merges) for ${Math.round((deps.waitMs ?? 300_000) / 60_000)} minutes; try again`);
				await sleep(deps.pollMs ?? 3_000);
			}
			const { id, base, ahead } = place;
			// Hold the place while the checks run: a merge quiet for QUIET_MS is taken to have gone.
			const beat = setInterval(() => void keepPlace(deps.log, id).catch(() => undefined), deps.heartbeatMs ?? HEARTBEAT_MS);
			let checked: Awaited<ReturnType<LineChecks["check"]>>;
			try {
				checked = await deps.check({ change, head, ref, agent: agent ?? change, ...(source ? { source } : {}), commands, base, ahead });
				// Failed after merges ahead: theirs, if one of them fails too (then this one checks again without it).
				if (!checked.passed && ahead.length && tries < MAX_TRIES && (await failureOf(deps.log, id, ahead, Date.now() + QUIET_MS, deps.pollMs ?? 3_000)) === "theirs") continue;
			} catch (err) {
				await leaveLine(deps.log, id, "gave up").catch(() => undefined);
				throw err;
			} finally {
				clearInterval(beat);
			}
			if (!checked.passed) {
				await leaveLine(deps.log, id, "failed").catch(() => undefined);
				return { passed: false, results: checked.results };
			}
			return passedInLine(deps, id, base, ahead, checked.results);
		}
	};
}

/** What mergeChange gets for a merge whose checks passed in line: what it lands after, how to tell the line it's done, and whether it still holds its place. */
async function passedInLine(deps: LineChecks, id: string, base: string, ahead: LineEntry[], results: CheckResult[]) {
	await markPassed(deps.log, id).catch(() => undefined);
	let shown = Date.now();
	return {
		passed: true,
		results,
		base,
		after: ahead.map((e) => ({ change: e.change, head: e.head })),
		done: async (landed: boolean, commit?: string) => {
			if (landed && commit) await landedFromLine(deps.log, id, commit);
			else await leaveLine(deps.log, id, "gave up");
		},
		// While it waits for its turn: still in line (a merge ahead that left takes this one along), showing it's still at it.
		inLine: async () => {
			if (Date.now() - shown >= (deps.heartbeatMs ?? HEARTBEAT_MS)) {
				shown = Date.now();
				return keepPlace(deps.log, id);
			}
			return holdsPlace(deps.log, id);
		},
	};
}
