import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { lampCounts, lampOf } from "./overview";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths,
	intent: change,
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const pushed = { head: "a".repeat(40) };
/** A minute after the claims were made: nobody's turn has run out. */
const soon = Date.parse("2026-10-09T00:01:00.000Z");
const approved = { ...pushed, approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } };

describe("a claim's lamp", () => {
	it("says where its change is, a person's question first, in the states everything else uses", () => {
		expect(lampOf(claim("a", ["x/"]), { now: soon })).toBe("building");
		expect(lampOf(claim("a", ["x/"], pushed), { now: soon })).toBe("in-review");
		expect(lampOf(claim("a", ["x/"], approved), { now: soon })).toBe("approved");
		const landing = { checking: { base: "m", since: "", changes: [{ change: "a", head: approved.head, agent: "a" }] } };
		expect(lampOf(claim("a", ["x/"], approved), { landing, now: soon })).toBe("landing");
		// Only its head as it's being checked: a newer push waits for review again.
		expect(lampOf(claim("a", ["x/"], { ...pushed, head: "b".repeat(40) }), { landing, now: soon })).toBe("in-review");
		expect(
			lampOf(claim("a", ["x/"], { ...approved, attention: { reason: "?", agent: "a", at: "" } }), {
				landing,
				now: soon,
			}),
		).toBe("needs-person");
		// A veto sends it back to its agent: changes requested, not a person's to answer.
		expect(
			lampOf(
				claim("a", ["x/"], {
					...pushed,
					approval: { approved: false, approvals: 0, required: 1, vetoedBy: ["security"] },
				}),
				{ now: soon },
			),
		).toBe("changes-requested");
		// A vote only people may give needs a person.
		const awaiting = {
			...pushed,
			approval: { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["sec"] },
		};
		const policy = { required: 1, vetoes: ["sec"], grants: { sec: ["person:*"] } };
		expect(lampOf(claim("a", ["x/"], awaiting), { policy, now: soon })).toBe("needs-person");
	});

	it("shows a change abandoned on its agent's turn, as the toolkit frees it, and never one waiting for review", () => {
		const hours = (n: number) => Date.parse("2026-10-09T00:00:00.000Z") + n * 3_600_000;
		expect(lampOf(claim("a", ["x/"]), { now: hours(1) })).toBe("abandoned");
		expect(lampOf(claim("a", ["x/"], pushed), { now: hours(24) })).toBe("in-review");
		const votes = [
			{
				commit: pushed.head,
				reviewer: "r",
				role: "review",
				verdict: "approve" as const,
				evidence: "",
				at: "2026-10-09T00:00:00.000Z",
			},
		];
		expect(lampOf(claim("a", ["x/"], approved), { votes, now: hours(1) })).toBe("approved");
		expect(lampOf(claim("a", ["x/"], approved), { votes, now: hours(3) })).toBe("abandoned");
		// Its checks failed, which rejects its head: handed back to its agent, then abandoned.
		const failed = [
			{
				commit: pushed.head,
				reviewer: "githive-checks",
				role: "checks",
				verdict: "reject" as const,
				evidence: "",
				at: "2026-10-09T00:00:00.000Z",
			},
		];
		expect(lampOf(claim("a", ["x/"], pushed), { votes: failed, now: hours(3) })).toBe("abandoned");
	});

	it("is counted per lamp", () => {
		const counts = lampCounts([claim("a", ["x/"]), claim("b", ["y/"], pushed), claim("c", ["z/"], pushed)], {
			now: soon,
		});
		expect(counts).toMatchObject({ building: 1, "in-review": 2, approved: 0 });
	});
});
