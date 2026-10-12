import { describe, expect, it } from "vitest";
import { ago, NOW } from "../test/fixtures";
import type { Goal } from "./goals";
import { goalMotions, MOST_MOTIONS, RIPPLE_MS } from "./hiveMotion";

const goal = (change: string, steps: Goal["steps"], extra: Partial<Goal> = {}): Goal => ({
	key: change,
	change,
	agent: "agent-1",
	title: change,
	intent: change,
	paths: [],
	state: "building",
	announced: steps[0]?.at ?? ago(10),
	steps,
	earlierSteps: false,
	...extra,
});

describe("what moves on the Hive tab", () => {
	it("moves nothing on the first read", () => {
		expect(goalMotions(undefined, [goal("a", [{ kind: "claimed", at: ago(1) }])], NOW)).toEqual([]);
	});

	it("brings a new goal in, and plays each new step of a known one, oldest first, rippling", () => {
		const before = [goal("a", [{ kind: "claimed", at: ago(10) }])];
		const after = [
			goal("b", [{ kind: "claimed", at: ago(1) }]),
			goal("a", [
				{ kind: "claimed", at: ago(10) },
				{ kind: "pushed", at: ago(3) },
				{ kind: "changes-asked", at: ago(2), by: "agent-5" },
			]),
		];
		const motions = goalMotions(before, after, NOW);
		expect(motions.map((each) => `${each.key}:${each.motion}`)).toEqual(["a:pushed", "a:changes-asked", "b:arrived"]);
		expect(motions.map((each) => each.delay)).toEqual([0, RIPPLE_MS, 2 * RIPPLE_MS]);
	});

	it("plays a change of state no step explains, such as the batch starting its checks", () => {
		const steps: Goal["steps"] = [{ kind: "claimed", at: ago(10) }];
		const motions = goalMotions(
			[goal("a", steps, { state: "approved" })],
			[goal("a", steps, { state: "landing" })],
			NOW,
		);
		expect(motions.map((each) => each.motion)).toEqual(["checking"]);
	});

	it("plays at most a few from one read; the rest just appear", () => {
		const after = Array.from({ length: 30 }, (_, index) => goal(`g${index}`, [{ kind: "claimed", at: ago(index) }]));
		expect(goalMotions([], after, NOW)).toHaveLength(MOST_MOTIONS);
	});
});
