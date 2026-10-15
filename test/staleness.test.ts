import { describe, expect, it } from "vitest";
import { abandonableAt, abandoned, CHALLENGE_WINDOW_MS, type ChangeSigns, waitingOn } from "../src/toolkit/staleness";

// A claim is abandoned only on its agent's turn, and only when another agent asked whether it's still there and got no
// answer in time: an agent waiting for review, for its change to be checked and land, or for a person is never robbed
// of its paths, and time alone frees nothing.

const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const signs = (over: Partial<ChangeSigns> = {}): ChangeSigns => ({
	active: at(0),
	head: "h1",
	votes: [],
	approved: false,
	landing: false,
	asked: false,
	...over,
});
const minutes = (n: number) => n * 60_000;
const day = 24 * 60 * minutes(1);

describe("whose turn a change is", () => {
	it("is its agent's until something is pushed, then the reviewers'", () => {
		expect(waitingOn(signs({ head: null }))).toEqual({ turn: "agent", why: "has nothing pushed" });
		expect(waitingOn(signs())).toMatchObject({ turn: "reviewers" });
	});

	it("goes back to the agent when changes are asked for (failed checks count) or it's approved and not merged", () => {
		expect(waitingOn(signs({ votes: [{ verdict: "reject", at: at(minutes(5)) }] }))).toEqual({
			turn: "agent",
			why: "had changes asked for",
		});
		expect(waitingOn(signs({ approved: true, votes: [{ verdict: "approve", at: at(minutes(9)) }] }))).toEqual({
			turn: "agent",
			why: "is approved and not merged",
		});
	});

	it("is the landing's or a person's while it waits on them, whatever else is true", () => {
		expect(waitingOn(signs({ landing: true, approved: true }))).toMatchObject({ turn: "landing" });
		expect(waitingOn(signs({ asked: true, head: null }))).toMatchObject({ turn: "person" });
	});
});

describe("an abandoned change", () => {
	it("is never one nobody asked about, however long its agent is quiet", () => {
		expect(abandoned(signs({ head: null }), T0 + day)).toMatchObject({
			abandoned: false,
			why: "has an agent no one has asked whether it's still there",
		});
		expect(abandoned(signs({ votes: [{ verdict: "reject", at: at(0) }] }), T0 + day).abandoned).toBe(false);
	});

	it("is one whose agent, on its turn, didn't answer within the window after it was asked", () => {
		const asked = signs({ head: null, challenged: at(minutes(5)) });
		const until = T0 + minutes(5) + CHALLENGE_WINDOW_MS;
		expect(abandoned(asked, until)).toMatchObject({ abandoned: false, why: expect.stringContaining("has until") });
		expect(abandoned(asked, until + 1)).toMatchObject({
			abandoned: true,
			why: "has nothing pushed, and its agent didn't answer when asked",
		});
	});

	it("is never one waiting for review, being checked to land, or on a person, even when asked", () => {
		const challenged = at(0);
		expect(abandoned(signs({ challenged }), T0 + day).abandoned).toBe(false);
		expect(abandoned(signs({ landing: true, challenged }), T0 + day).abandoned).toBe(false);
		expect(abandoned(signs({ asked: true, head: null, challenged }), T0 + day).abandoned).toBe(false);
	});
});

describe("when a claim frees up", () => {
	it("is the end of the window after its agent was asked, while the change waits on it", () => {
		const challenged = at(minutes(3));
		expect(abandonableAt(signs({ head: null, challenged }))).toBe(T0 + minutes(3) + CHALLENGE_WINDOW_MS);
		expect(abandonableAt(signs({ approved: true, challenged }))).toBe(T0 + minutes(3) + CHALLENGE_WINDOW_MS);
	});

	it("is never while nobody has asked, or its change waits on reviewers, a landing or a person", () => {
		expect(abandonableAt(signs({ head: null }))).toBeUndefined();
		expect(abandonableAt(signs({ challenged: at(0) }))).toBeUndefined();
		expect(abandonableAt(signs({ landing: true, approved: true, challenged: at(0) }))).toBeUndefined();
		expect(abandonableAt(signs({ asked: true, head: null, challenged: at(0) }))).toBeUndefined();
	});
});
