import type { Goal, GoalStepKind } from "./goals";
import { timeOf } from "./model";
import { durationWords } from "./stretch";

// The goals panel's clock: one axis every goal's bar is drawn on. It slides rather than zooming to fit: "now" sits
// at the right edge and the scale is fixed, so a bar's length always means the same time. Stretches when nothing was
// in flight that are long next to the range fold into a break, so the last burst of work sits next to now.

const MINUTE = 60_000;

/** The ranges a person can pick, shortest first. */
export const RANGES = [15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE, 24 * 60 * MINUTE];

/** The range when there's nothing to fit. */
export const DEFAULT_RANGE = 60 * MINUTE;

export const RANGE_WORDS: Record<number, string> = {
	[15 * MINUTE]: "15 min",
	[30 * MINUTE]: "30 min",
	[60 * MINUTE]: "1 h",
	[6 * 60 * MINUTE]: "6 h",
	[24 * 60 * MINUTE]: "24 h",
};

/** How much of the width a folded quiet stretch takes. */
const BREAK_WIDTH = 0.05;
/** A quiet stretch folds when it's longer than this part of the range. */
const FOLDS_PAST = 0.25;
/** At most this many breaks; past that, quiet stretches are drawn as they are. */
const MAX_BREAKS = 3;

type Span = Pick<Goal, "announced" | "finished">;

const timeAt = (iso: string) => timeOf(iso) ?? 0;

/**
 * The smallest range that holds every goal in flight from its start or, when none is, the last stretch of work
 * (the quiet since then folds away); an hour when there's nothing at all. Picked once, when the panel opens.
 */
export function chooseRange(goals: Span[], now: number): number {
	const fits = (holds: (range: number) => boolean) => RANGES.find(holds) ?? RANGES[RANGES.length - 1]!;
	const open = goals.filter((goal) => !goal.finished);
	if (open.length) {
		const span = now - Math.min(...open.map((goal) => timeAt(goal.announced)));
		return fits((range) => range >= span * 1.1);
	}
	const stretches = busyStretches(goals, now);
	const last = stretches[0];
	if (!last) return DEFAULT_RANGE;
	return fits((range) => {
		// The last run of work: stretches closer than a fold are drawn together, so they must fit together.
		let from = last.from;
		for (const earlier of stretches.slice(1)) {
			if (from - earlier.to > range * FOLDS_PAST) break;
			from = earlier.from;
		}
		const folds = now - last.to > range * FOLDS_PAST;
		return range >= (folds ? last.to - from : now - from) * 1.1;
	});
}

export interface AxisPiece {
	kind: "time" | "quiet";
	from: number;
	to: number;
	/** Where it starts and ends across the axis, 0 to 1. */
	x0: number;
	x1: number;
}

export interface Axis {
	range: number;
	now: number;
	/** The earliest time drawn. */
	start: number;
	/** Oldest first: stretches of time drawn to scale, and the quiet ones folded between them. */
	pieces: AxisPiece[];
	/** Where a time falls across the axis, 0 to 1; undefined before it starts. */
	x(time: number): number | undefined;
	/** Labels along it. */
	ticks: { x: number; label: string }[];
}

/**
 * The axis for `range` ending at `now`. Walking back from now, quiet stretches (no goal in flight) longer than a
 * quarter of the range fold, and the axis reaches further back by as much, so `range` of time is always drawn.
 */
export function timeAxis(goals: Span[], range: number, now: number): Axis {
	const busy = busyStretches(goals, now);
	const shown: { from: number; to: number }[] = [];
	const quiet: { from: number; to: number }[] = [];
	let cursor = now;
	let left = range;
	const take = (length: number) => {
		const taken = Math.min(length, left);
		if (taken > 0) shown.push({ from: cursor - taken, to: cursor });
		cursor -= taken;
		left -= taken;
	};
	for (const stretch of busy) {
		if (left <= 0) break;
		const gap = cursor - stretch.to;
		// A long quiet stretch folds, the one up to now too, so the last stretch of work sits next to now.
		if (gap > range * FOLDS_PAST && quiet.length < MAX_BREAKS) {
			quiet.push({ from: stretch.to, to: cursor });
			cursor = stretch.to;
		} else take(gap);
		if (left > 0) take(cursor - Math.max(stretch.from, cursor - left));
	}
	if (left > 0) take(left);

	const drawnWidth = 1 - quiet.length * BREAK_WIDTH;
	const pieces: AxisPiece[] = [];
	const all = [
		...shown.map((piece) => ({ kind: "time" as const, ...piece })),
		...quiet.map((piece) => ({ kind: "quiet" as const, ...piece })),
	].sort((a, b) => a.from - b.from);
	// Touching pieces of time drawn to scale are one piece.
	const merged: typeof all = [];
	for (const piece of all) {
		const previous = merged[merged.length - 1];
		if (previous && previous.kind === "time" && piece.kind === "time" && previous.to === piece.from)
			previous.to = piece.to;
		else merged.push({ ...piece });
	}
	let x = 0;
	for (const piece of merged) {
		const width = piece.kind === "quiet" ? BREAK_WIDTH : ((piece.to - piece.from) / range) * drawnWidth;
		pieces.push({ ...piece, x0: x, x1: x + width });
		x += width;
	}
	const start = pieces[0]?.from ?? now - range;
	const at = (time: number) => {
		if (time < start) return undefined;
		if (time >= now) return 1;
		for (const piece of pieces) {
			if (time > piece.to) continue;
			if (piece.kind === "quiet") return (piece.x0 + piece.x1) / 2;
			const span = piece.to - piece.from;
			return span ? piece.x0 + ((time - piece.from) / span) * (piece.x1 - piece.x0) : piece.x0;
		}
		return 1;
	};
	return { range, now, start, pieces, x: at, ticks: ticksOf(pieces) };
}

/** Times when some goal was in flight, merged, newest first. */
function busyStretches(goals: Span[], now: number) {
	const stretches = goals
		.map((goal) => ({ from: timeAt(goal.announced), to: goal.finished ? timeAt(goal.finished) : now }))
		.sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const stretch of stretches) {
		const last = merged[merged.length - 1];
		if (last && stretch.from <= last.to) last.to = Math.max(last.to, stretch.to);
		else merged.push({ ...stretch });
	}
	return merged.reverse();
}

/** "21:44", on the reader's clock, whatever the day: the axis's labels and the strip's "since". */
export function hhmm(time: number): string {
	const at = new Date(time);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** How close two labels may sit, as a part of the axis, before the later one is left out. */
const TICK_ROOM = 0.14;

/** A clock label where each stretch of time starts, one in the middle of a wide one, and "now", none crowding. */
function ticksOf(pieces: AxisPiece[]): { x: number; label: string }[] {
	const wanted: { x: number; label: string }[] = [];
	for (const piece of pieces) {
		if (piece.kind === "quiet") continue;
		wanted.push({ x: piece.x0, label: hhmm(piece.from) });
		if (piece.x1 - piece.x0 > 0.45)
			wanted.push({ x: (piece.x0 + piece.x1) / 2, label: hhmm((piece.from + piece.to) / 2) });
	}
	const ticks: { x: number; label: string }[] = [];
	for (const tick of wanted) {
		const last = ticks[ticks.length - 1];
		if ((!last || tick.x - last.x >= TICK_ROOM) && 1 - tick.x >= TICK_ROOM) ticks.push(tick);
	}
	ticks.push({ x: 1, label: "now" });
	return ticks;
}

/** How a folded quiet stretch reads: "3 hours quiet". */
export const quietWords = (piece: AxisPiece) => `${durationWords(piece.to - piece.from)} quiet`;

/** A stretch of a goal's bar, drawn by what the goal was doing then. */
export interface BarPhase {
	kind: "building" | "review" | "landing" | "dropped";
	x0: number;
	x1: number;
}

/** A mark on a goal's bar: a step that happened at one moment. */
export interface BarMark {
	kind: GoalStepKind;
	x: number;
	at: string;
	by?: string;
	/** Loud marks show in Story too; quiet ones only in Timeline. */
	loud: boolean;
}

export interface Bar {
	phases: BarPhase[];
	marks: BarMark[];
	/** How it ended, at its end. */
	end?: { kind: "landed" | "released"; x: number };
	/** It started before the axis: how long ago, for the marker at the left edge. */
	clipped?: string;
}

const PHASE_AFTER: Partial<Record<GoalStepKind, BarPhase["kind"]>> = {
	claimed: "building",
	pushed: "review",
	"changes-asked": "building",
	failed: "building",
	merging: "landing",
	checking: "landing",
};

/** Marks Story shows too: votes, failures, questions, and what agents hear about each other. */
const LOUD: GoalStepKind[] = ["changes-asked", "approved", "failed", "asked", "conflicted", "heads-up", "interface"];

/** A goal's bar on the axis: what it was doing when, the steps as marks, and how it ended. */
export function goalBar(goal: Goal, axis: Axis): Bar {
	const end = goal.finished ? timeAt(goal.finished) : axis.now;
	const startTime = timeAt(goal.announced);
	const phases: BarPhase[] = [];
	const marks: BarMark[] = [];
	let phase: BarPhase["kind"] = "building";
	let from = startTime;
	const close = (to: number) => {
		const x0 = axis.x(Math.max(from, axis.start)) ?? 0;
		const x1 = axis.x(to);
		if (x1 !== undefined && x1 > x0) phases.push({ kind: phase, x0, x1 });
	};
	for (const step of goal.steps) {
		const at = timeAt(step.at);
		const next = PHASE_AFTER[step.kind];
		if (next && next !== phase && at > from) {
			close(at);
			from = at;
			phase = next;
		} else if (next) phase = next;
		const x = axis.x(at);
		if (x !== undefined && step.kind !== "claimed" && step.kind !== "landed" && step.kind !== "released")
			marks.push({
				kind: step.kind,
				x,
				at: step.at,
				...(step.by ? { by: step.by } : {}),
				loud: LOUD.includes(step.kind),
			});
	}
	// What the goal is doing now outranks what the steps we have say (the log may have lost some).
	if (!goal.finished) {
		const now = nowPhase(goal);
		if (now && now !== phase) {
			const since = lastPhaseStart(goal, now) ?? from;
			if (since > from) {
				close(since);
				from = since;
			}
			phase = now;
		}
	}
	if (goal.state === "released") phase = "dropped";
	close(end);
	const bar: Bar = { phases, marks };
	if (goal.finished && (goal.state === "landed" || goal.state === "released")) {
		const x = axis.x(end);
		if (x !== undefined) bar.end = { kind: goal.state, x };
	}
	if (startTime < axis.start) bar.clipped = `started ${durationWords(axis.now - startTime)} ago`;
	return bar;
}

function nowPhase(goal: Goal): BarPhase["kind"] | undefined {
	switch (goal.state) {
		case "building":
		case "changes-requested":
		case "checks-failed":
			return "building";
		case "in-review":
		case "needs-person":
		case "approved":
			return "review";
		case "landing":
			return "landing";
		default:
			return undefined;
	}
}

/** When the goal's current phase began, from its last step that leads into it. */
function lastPhaseStart(goal: Goal, phase: BarPhase["kind"]): number | undefined {
	for (let index = goal.steps.length - 1; index >= 0; index--) {
		const step = goal.steps[index]!;
		if (PHASE_AFTER[step.kind] === phase) return timeAt(step.at);
	}
	return undefined;
}
