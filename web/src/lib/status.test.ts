import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { CHANGE_STATES, changeState, peopleOnly, STATES, waitingOn } from "./status";

type Claim = RepoSnapshot["claims"][number];
type Vote = RepoSnapshot["votes"][number];

const HEAD = "a".repeat(40);
const claim = (over: Partial<Claim> = {}): Claim => ({
	change: "c-1",
	agent: "agent-c",
	paths: ["src/c/"],
	intent: "Rewrite the C section",
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: HEAD,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const vote = (over: Partial<Vote> = {}): Vote => ({
	commit: HEAD,
	reviewer: "rev-1",
	role: "review",
	verdict: "reject",
	evidence: "",
	at: "2026-10-09T00:00:00.000Z",
	...over,
});
const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };
const awaiting = (role: string) => ({ approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: [role] });
const peopleHold = (role: string): RepoSnapshot["policy"] => ({
	required: 1,
	vetoes: [role],
	grants: { [role]: ["person:*"] },
});
const landing = { checking: { base: "m", since: "", changes: [{ change: "c-1", head: HEAD, agent: "agent-c" }] } };
const question = { reason: "should sendFile follow symlinks?", agent: "agent-c", at: "2026-10-09T00:05:00.000Z" };

describe("the change states", () => {
	it("give each state one noun, and the same words in lowercase for cells, rows and legends", () => {
		expect(CHANGE_STATES.map((state) => STATES[state].label)).toEqual([
			"Needs a person",
			"Changes requested",
			"Checks failed",
			"Abandoned, free to take",
			"Landing",
			"Approved",
			"In review",
			"Building",
			"Landed",
			"Released",
		]);
		for (const state of CHANGE_STATES) expect(STATES[state].short).toBe(STATES[state].label.toLowerCase());
	});

	it("keep amber for landing alone, and the Hive's colors for the rest", () => {
		const amber = CHANGE_STATES.filter((state) => STATES[state].color === "stage-landing");
		expect(amber).toEqual(["landing"]);
		expect(STATES.building.color).toBe("stage-building");
		expect(STATES["in-review"].color).toBe("stage-review");
		expect(STATES["needs-person"].color).toBe("bad");
		expect(STATES.approved.color).toBe("good");
		expect(STATES.landed.color).toBe("stage-landed");
	});

	it("never tell two states apart by color alone: a glyph or a pattern differs too", () => {
		for (const a of CHANGE_STATES)
			for (const b of CHANGE_STATES) {
				if (a === b || STATES[a].color === STATES[b].color) continue;
				const same = STATES[a].glyph === STATES[b].glyph && STATES[a].pattern === STATES[b].pattern;
				expect(same, `${a} and ${b}`).toBe(false);
			}
		expect(STATES["needs-person"].glyph).toBe("!");
		expect(STATES["changes-requested"].glyph).toBe("×");
		expect(STATES["checks-failed"].glyph).toBe("×");
		expect(STATES["in-review"].pattern).toBe("dashed");
	});
});

describe("a change's state", () => {
	it("is building until something is pushed, then in review", () => {
		expect(changeState(claim({ head: null }))).toBe("building");
		expect(changeState(claim())).toBe("in-review");
	});

	it("needs a person while its agent asks one, or GitHive's builder failed, before anything else", () => {
		expect(changeState(claim({ attention: question, approval: approved }), { landing })).toBe("needs-person");
		expect(changeState(claim({ head: null, attention: question }))).toBe("needs-person");
		const failed = { builder: { status: "failed", revisions: 0 }, reviewers: [] };
		expect(changeState(claim({ hosted: failed }))).toBe("needs-person");
	});

	it("needs a person when a pushed change waits on a vote only people may give", () => {
		const waiting = claim({ approval: awaiting("security") });
		expect(changeState(waiting, { policy: peopleHold("security") })).toBe("needs-person");
		// Agents and GitHive's reviewers hold the role by default: it's in review.
		expect(changeState(waiting, { policy: { required: 1, vetoes: ["security"] } })).toBe("in-review");
		expect(changeState(waiting)).toBe("in-review");
		// Sent back to its agent, it's the agent's turn.
		expect(changeState(waiting, { policy: peopleHold("security"), votes: [vote()] })).toBe("changes-requested");
	});

	it("reads rejections on its head before its approval: failed checks apart from a reviewer's", () => {
		const done = claim({ approval: approved });
		expect(changeState(done, { votes: [vote({ reviewer: "githive-checks", role: "checks" })] })).toBe("checks-failed");
		expect(changeState(done, { votes: [vote()] })).toBe("changes-requested");
		expect(changeState(claim({ approval: { ...approved, approved: false, vetoedBy: ["security"] } }))).toBe(
			"changes-requested",
		);
		// An earlier head's rejection, or its own agent's, says nothing of this one.
		expect(changeState(done, { votes: [vote({ commit: "b".repeat(40) })] })).toBe("approved");
		expect(changeState(done, { votes: [vote({ reviewer: "agent-c" })] })).toBe("approved");
	});

	it("takes a hosted reviewer's rejection as changes requested until it's approved", () => {
		const rejected = { reviewers: [{ role: "security", status: "done", verdict: "reject" }] };
		expect(changeState(claim({ hosted: rejected }))).toBe("changes-requested");
		expect(changeState(claim({ hosted: rejected, approval: approved }))).toBe("approved");
	});

	it("is landing while its head is checked to land, and only that head", () => {
		expect(changeState(claim({ approval: approved }), { landing })).toBe("landing");
		expect(changeState(claim({ approval: approved, head: "b".repeat(40) }), { landing })).toBe("approved");
	});

	it("is landing still when a veto or a rejection comes while it's checked: the batch lands it all the same", () => {
		const vetoed = { ...approved, approved: false, vetoedBy: ["sec-bot"] };
		const security = vote({ reviewer: "sec-bot", role: "security" });
		expect(changeState(claim({ approval: vetoed }), { landing, votes: [security] })).toBe("landing");
		expect(changeState(claim({ approval: approved }), { landing, votes: [vote()] })).toBe("landing");
		const rejected = { reviewers: [{ role: "security", status: "done", verdict: "reject" }] };
		expect(changeState(claim({ approval: approved, hosted: rejected }), { landing })).toBe("landing");
	});

	it("is abandoned once its agent's turn has gone unanswered, when the time is given", () => {
		const hours = (n: number) => Date.parse("2026-10-09T00:00:00.000Z") + n * 3_600_000;
		expect(changeState(claim({ head: null }), { now: hours(1) })).toBe("abandoned");
		expect(changeState(claim({ head: null }))).toBe("building");
		// Waiting for review is nobody's fault: it never frees.
		expect(changeState(claim(), { now: hours(24) })).toBe("in-review");
		// A question for a person comes first.
		expect(changeState(claim({ head: null, attention: question }), { now: hours(24) })).toBe("needs-person");
	});
});

describe("what waits on a person", () => {
	it("is an agent's question, with who asks and why", () => {
		expect(waitingOn(claim({ attention: { ...question, urgency: 1.8 } }))).toEqual({
			kind: "question",
			change: "c-1",
			agent: "agent-c",
			reason: "should sendFile follow symlinks?",
			at: question.at,
			urgency: 1.8,
		});
		const failed = { builder: { status: "failed", revisions: 0, error: "boom" }, reviewers: [] };
		expect(waitingOn(claim({ hosted: failed }))).toMatchObject({
			kind: "question",
			agent: "githive-builder",
			reason: "GitHive's builder failed: boom",
		});
	});

	it("is a vote only people may give, on a pushed change not sent back", () => {
		const policy = peopleHold("security");
		expect(waitingOn(claim({ approval: awaiting("security") }), { policy })).toEqual({
			kind: "vote",
			change: "c-1",
			role: "security",
		});
		expect(waitingOn(claim({ head: null, approval: awaiting("security") }), { policy })).toBeUndefined();
		expect(waitingOn(claim({ approval: awaiting("security") }), { policy, votes: [vote()] })).toBeUndefined();
	});

	it("isn't failed checks: they're the agent's to fix", () => {
		const votes = [vote({ reviewer: "githive-checks", role: "checks" })];
		expect(waitingOn(claim({ approval: approved }), { votes })).toBeUndefined();
	});
});

describe("who may vote as a role", () => {
	it("is people only when every holder is a person, people, or a team", () => {
		const policy = (holders: string[]): RepoSnapshot["policy"] => ({
			required: 1,
			vetoes: ["security"],
			grants: { security: holders },
		});
		expect(peopleOnly(policy(["person:*"]), "security")).toBe(true);
		expect(peopleOnly(policy(["person:ada", "@acme/security"]), "security")).toBe(true);
		expect(peopleOnly(policy(["person:*", "sec-agent"]), "security")).toBe(false);
		expect(peopleOnly(policy([]), "security")).toBe(false);
		// The default grant includes GitHive's reviewers.
		expect(peopleOnly({ required: 1, vetoes: ["security"] }, "security")).toBe(false);
		expect(peopleOnly(undefined, "security")).toBe(false);
	});
});
