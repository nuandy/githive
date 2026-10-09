import { describe, expect, it } from "vitest";
import { abandoned, AGENT_TURN_IDLE_MS, BUILDING_IDLE_MS, type ChangeSigns, waitingOn } from "../src/toolkit/staleness";

// A claim is abandoned only on its agent's turn: an agent waiting for review,
// for the line, or for a person is never robbed of its paths.

const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const signs = (over: Partial<ChangeSigns> = {}): ChangeSigns => ({ active: at(0), head: "h1", votes: [], approved: false, inLine: false, asked: false, ...over });
const minutes = (n: number) => n * 60_000;

describe("whose turn a change is", () => {
	it("is its agent's until something is pushed, then the reviewers'", () => {
		expect(waitingOn(signs({ head: null }))).toMatchObject({ turn: "agent", idleAfterMs: BUILDING_IDLE_MS });
		expect(waitingOn(signs())).toMatchObject({ turn: "reviewers" });
	});

	it("goes back to the agent when changes are asked for, its checks fail in line, or it's approved and not merged", () => {
		expect(waitingOn(signs({ votes: [{ verdict: "reject", at: at(minutes(5)) }] }))).toMatchObject({ turn: "agent", since: at(minutes(5)) });
		expect(waitingOn(signs({ leftLineAt: at(minutes(7)) }))).toMatchObject({ turn: "agent", since: at(minutes(7)) });
		expect(waitingOn(signs({ approved: true, votes: [{ verdict: "approve", at: at(minutes(9)) }] }))).toMatchObject({ turn: "agent", since: at(minutes(9)), why: "is approved and not merged" });
	});

	it("is the line's or a person's while it waits on them, whatever else is true", () => {
		expect(waitingOn(signs({ inLine: true, approved: true }))).toMatchObject({ turn: "line" });
		expect(waitingOn(signs({ asked: true, head: null }))).toMatchObject({ turn: "person" });
	});

	it("counts from the agent's own last claim when that's later than what handed the turn back", () => {
		expect(waitingOn(signs({ active: at(minutes(20)), votes: [{ verdict: "reject", at: at(minutes(5)) }] })).since).toBe(at(minutes(20)));
	});
});

describe("an abandoned change", () => {
	it("is one its agent hasn't answered for longer than its turn allows", () => {
		expect(abandoned(signs({ head: null }), T0 + BUILDING_IDLE_MS - 1).abandoned).toBe(false);
		expect(abandoned(signs({ head: null }), T0 + BUILDING_IDLE_MS + 1).abandoned).toBe(true);
		const failed = signs({ leftLineAt: at(0) });
		expect(abandoned(failed, T0 + AGENT_TURN_IDLE_MS - 1).abandoned).toBe(false);
		expect(abandoned(failed, T0 + AGENT_TURN_IDLE_MS + 1).abandoned).toBe(true);
	});

	it("is never one waiting for review, the line or a person, however long", () => {
		const day = 24 * 60 * minutes(1);
		expect(abandoned(signs(), T0 + day).abandoned).toBe(false);
		expect(abandoned(signs({ inLine: true }), T0 + day).abandoned).toBe(false);
		expect(abandoned(signs({ asked: true, head: null }), T0 + day).abandoned).toBe(false);
	});

	it("is never sooner than the floor after its agent last claimed", () => {
		// Handed back long ago, but the agent claimed again a minute ago: it's at work.
		expect(abandoned(signs({ active: at(AGENT_TURN_IDLE_MS + minutes(9)), leftLineAt: at(0) }), T0 + AGENT_TURN_IDLE_MS + minutes(10)).abandoned).toBe(false);
	});
});
