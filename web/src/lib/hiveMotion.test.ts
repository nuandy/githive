import { describe, expect, it } from "vitest";
import { ago, NOW } from "../test/fixtures";
import type { Goal } from "./goals";
import { announcement, goalMotions, holdLayout, MOST_MOTIONS, pendingWords, RIPPLE_MS } from "./hiveMotion";

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

describe("what a screen reader hears", () => {
	it("says a landing, a failure, and what a person is needed for: a question, or a vote", () => {
		const shown = goal("refunds", [], { agent: "devon/codex", title: "Handle refunds" });
		expect(announcement(shown, "landed")).toBe("devon/codex landed Handle refunds");
		expect(announcement(shown, "failed")).toBe("Handle refunds failed its checks");
		const asks = {
			...shown,
			waiting: { kind: "question" as const, change: "refunds", agent: "", reason: "?", at: "" },
		};
		expect(announcement(asks, "asking")).toBe("devon/codex is asking a person about Handle refunds");
		const votes = { ...shown, waiting: { kind: "vote" as const, change: "refunds", role: "payments" } };
		expect(announcement(votes, "asking")).toBe("Handle refunds waits on a payments vote from a person");
		expect(announcement(shown, "pushed")).toBeUndefined();
	});
});

describe("the goals panel held still while it's read", () => {
	const shown = { inFlight: ["c", "b", "a"], done: ["z"] };

	it("follows every change while nobody's reading", () => {
		const next = { inFlight: ["d", "c", "a"], done: ["b", "z"] };
		expect(holdLayout(shown, next, false)).toEqual({ shown: next, arrived: [], finished: [] });
		// And on the first read, there's nothing to hold.
		expect(holdLayout(undefined, next, true)).toEqual({ shown: next, arrived: [], finished: [] });
	});

	it("keeps rows where they are while paused, and counts what waits: new goals, and goals that finished", () => {
		const next = { inFlight: ["d", "c", "a"], done: ["b", "z"] };
		expect(holdLayout(shown, next, true)).toEqual({
			shown: { inFlight: ["c", "b", "a"], done: ["z"] },
			arrived: ["d"],
			finished: ["b"],
		});
	});

	it("holds nothing when nothing's drawn yet: the first goal comes in", () => {
		const next = { inFlight: ["a"], done: [] };
		expect(holdLayout({ inFlight: [], done: [] }, next, true).shown).toEqual(next);
	});

	it("lets a goal that's gone go, even while paused", () => {
		const next = { inFlight: ["c", "a"], done: ["z"] };
		expect(holdLayout(shown, next, true).shown).toEqual({ inFlight: ["c", "a"], done: ["z"] });
	});

	it("holds the same way however often it's asked", () => {
		const next = { inFlight: ["d", "c", "a"], done: ["b", "z"] };
		const once = holdLayout(shown, next, true);
		expect(holdLayout(once.shown, next, true)).toEqual(once);
	});

	it("says what waits in a few words", () => {
		expect(pendingWords(["d", "e"], [])).toBe("2 new");
		expect(pendingWords([], ["b"])).toBe("1 finished");
		expect(pendingWords(["d"], ["b"])).toBe("1 new · 1 finished");
	});
});
