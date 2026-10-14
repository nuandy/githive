import { describe, expect, it } from "vitest";
import { changeSigns } from "../src/toolkit/tools/change-state";
import { waitingOn } from "../src/toolkit/staleness";
import type { ClaimRecord } from "../src/toolkit/claims";
import type { FlagRecord, VoteRecord } from "../src/toolkit/votes";

// Whose turn a change is on, as status, the dashboard and the stale-claim rule read it.

const HEAD = "a".repeat(40);
const claim: ClaimRecord = {
	change: "c-1",
	agent: "builder",
	paths: ["src/"],
	intent: "a change",
	since: "2026-10-14T10:00:00.000Z",
	active: "2026-10-14T10:00:00.000Z",
};
// GitHive's reviewer holds the security role, so its sign-off isn't a person's vote.
const policy = { required: 0, vetoes: ["security"], grants: { security: ["githive"] } };
const roleWait: FlagRecord = {
	change: "c-1",
	agent: "githive",
	reason: "the security review has waited",
	role: "security",
	at: "2026-10-14T10:20:00.000Z",
};
const signOff: VoteRecord = {
	commit: HEAD,
	reviewer: "githive-security",
	by: "service:githive-reviewer:security",
	role: "security",
	verdict: "approve",
	evidence: "no new dependencies",
	at: "2026-10-14T10:30:00.000Z",
};

describe("a change's signs", () => {
	it("stops waiting on a person once the role its flag asked for signs off", () => {
		const waiting = changeSigns({ claim, head: HEAD, counted: [], record: { votes: [], flags: [roleWait] }, policy });
		expect(waitingOn(waiting).turn).toBe("person");
		const record = { votes: [signOff], flags: [roleWait] };
		const signed = changeSigns({ claim, head: HEAD, counted: [signOff], record, policy });
		expect(signed.asked).toBe(false);
		expect(waitingOn(signed).turn).not.toBe("person");
	});

	it("counts a lone agent's own approval, so its claim can be abandoned if it then goes quiet", () => {
		const own: VoteRecord = {
			commit: HEAD,
			reviewer: "builder",
			role: "review",
			verdict: "approve",
			evidence: "reviewed in a fresh context; tests pass",
			at: "2026-10-14T10:40:00.000Z",
		};
		const record = { votes: [own], flags: [] };
		const reviewed = { required: 1, vetoes: [] as string[] };
		const signs = changeSigns({ claim, head: HEAD, counted: [own], record, policy: reviewed });
		expect(signs.approved).toBe(true);
		expect(waitingOn(signs)).toMatchObject({ turn: "agent", why: "is approved and not merged" });
	});
});
