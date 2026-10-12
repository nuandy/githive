import { describe, expect, it } from "vitest";
import { ago, NOW } from "../test/fixtures";
import type { Goal } from "./goals";
import { chooseRange, goalBar, RANGES, timeAxis } from "./timeAxis";

const MINUTE = 60_000;
const [QUARTER, HALF, HOUR, SIX_HOURS] = RANGES as [number, number, number, number, number];

const goal = (announced: number, extra: Partial<Goal> = {}): Goal => ({
	key: `c-${announced}`,
	change: `c-${announced}`,
	agent: "agent-1",
	title: "t",
	intent: "t",
	paths: [],
	state: "building",
	announced: ago(announced),
	steps: [{ kind: "claimed", at: ago(announced) }],
	earlierSteps: false,
	...extra,
});

describe("the goals panel's range", () => {
	it("is the smallest that holds every goal in flight from its start", () => {
		expect(chooseRange([goal(10)], NOW)).toBe(QUARTER);
		expect(chooseRange([goal(10), goal(20)], NOW)).toBe(HALF);
		expect(chooseRange([goal(40)], NOW)).toBe(HOUR);
	});

	it("holds the last stretch of work when nothing is in flight, folding the quiet since", () => {
		const done = goal(200, { state: "landed", finished: ago(180) });
		// 20 minutes of work three hours ago: half an hour holds it, with the three quiet hours folded.
		expect(chooseRange([done], NOW)).toBe(HALF);
	});

	it("holds a run of work with a moment's pause in it whole", () => {
		// 15 minutes of work, with 11 seconds between one landing and the next claim, an hour and a half ago.
		const first = goal(105, { state: "landed", finished: ago(93) });
		const second = goal(92.8, { state: "landed", finished: ago(90) });
		expect(chooseRange([first, second], NOW)).toBe(HALF);
	});

	it("is an hour when there's nothing at all", () => {
		expect(chooseRange([], NOW)).toBe(HOUR);
	});
});

describe("the time axis", () => {
	it("draws the range to scale with now at the right edge", () => {
		const axis = timeAxis([goal(10)], HOUR, NOW);
		expect(axis.x(NOW)).toBe(1);
		expect(axis.x(NOW - HOUR / 2)).toBeCloseTo(0.5);
		expect(axis.x(NOW - 2 * HOUR)).toBeUndefined();
		expect(axis.ticks.at(-1)).toEqual({ x: 1, label: "now" });
	});

	it("folds a long quiet stretch, reaching back by as much, so the last burst sits next to now", () => {
		const done = goal(200, { state: "landed", finished: ago(180) });
		const axis = timeAxis([done], HOUR, NOW);
		const quiet = axis.pieces.filter((piece) => piece.kind === "quiet");
		expect(quiet).toHaveLength(1);
		expect(quiet[0]!.to - quiet[0]!.from).toBe(180 * MINUTE);
		// The burst, 3 hours ago, is on the axis.
		expect(axis.x(NOW - 190 * MINUTE)).toBeGreaterThan(0);
		expect(axis.start).toBe(NOW - 180 * MINUTE - HOUR);
	});

	it("doesn't fold a quiet stretch short next to the range", () => {
		const done = goal(30, { state: "landed", finished: ago(25) });
		expect(timeAxis([done], SIX_HOURS, NOW).pieces.every((piece) => piece.kind === "time")).toBe(true);
	});
});

describe("a goal's bar", () => {
	it("draws building, review and landing in turn, with a mark at each vote", () => {
		const steps: Goal["steps"] = [
			{ kind: "claimed", at: ago(20) },
			{ kind: "pushed", at: ago(15) },
			{ kind: "changes-asked", at: ago(13), by: "agent-5" },
			{ kind: "pushed", at: ago(10) },
			{ kind: "approved", at: ago(5), by: "agent-19" },
			{ kind: "checking", at: ago(2) },
		];
		const bar = goalBar(goal(20, { state: "landing", steps }), timeAxis([], HOUR, NOW));
		expect(bar.phases.map((phase) => phase.kind)).toEqual(["building", "review", "building", "review", "landing"]);
		expect(bar.marks.filter((mark) => mark.loud).map((mark) => mark.kind)).toEqual(["changes-asked", "approved"]);
		expect(bar.phases.at(-1)?.x1).toBe(1);
	});

	it("ends with what became of it, and says how long ago it started when that's off the axis", () => {
		const landed = goal(30, { state: "landed", finished: ago(5) });
		const bar = goalBar(landed, timeAxis([landed], QUARTER, NOW));
		expect(bar.end?.kind).toBe("landed");
		expect(bar.clipped).toBe("started 30 minutes ago");
	});
});
