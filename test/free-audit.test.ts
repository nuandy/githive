import { describe, expect, it } from "vitest";
import { audit, type MergeRecord } from "../src/free/audit";
import type { Registry } from "../src/free/claims";
import type { Votes } from "../src/free/votes";

// The coordinator-free audit: nothing stopped an agent from breaking a
// convention, so a pure replay of the records reports every violation, with
// the commit and the agent responsible.

const at = (claims: Registry["claims"], released: Registry["released"] = []): Registry => ({ claims, released });
const claimA = { change: "stats-1a2b", agent: "agent-a", paths: ["src/stats/"], intent: "Add stats", since: "", active: "2026-10-05T10:00:00.000Z" };
const claimB = { change: "docs-3c4d", agent: "agent-b", paths: ["docs/"], intent: "Docs", since: "", active: "2026-10-05T10:00:00.000Z" };
// The registry's history, oldest first: a's claim, then b's too.
const registry = [
	{ tip: "r1", state: at([claimA]) },
	{ tip: "r2", state: at([claimA, claimB]) },
];
const approve = (reviewer: string, role: string, commit = "h1") => ({ commit, reviewer, role, verdict: "approve" as const, evidence: "ok", at: "" });
const policy = { required: 2, vetoes: ["security"] };
// The votes' history: two approvals of a's head h1.
const votes: { tip: string; state: Votes }[] = [{ tip: "v1", state: { votes: [approve("rev-1", "tests"), approve("rev-2", "api")] } }];
const merge = (overrides: Partial<MergeRecord>): MergeRecord => ({ commit: "m1", author: "agent-a", change: "stats-1a2b", claimsTip: "r2", head: "h1", votesTip: "v1", files: ["src/stats/index.ts"], ...overrides });
const records = (merges: MergeRecord[], reg = registry) => ({ registry: reg, votes, policy, merges });

describe("the audit", () => {
	it("finds nothing wrong with a merge inside its own claim", async () => {
		expect(await audit(records([merge({})]))).toEqual([]);
	});

	it("reports a merge that changed files outside its claim", async () => {
		expect(await audit(records([merge({ files: ["src/stats/index.ts", "src/router.ts"] })]))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "outside-claim", detail: "src/router.ts was not in stats-1a2b's claim at r2" },
		]);
	});

	it("reports a merge that edited inside another change's claim, naming whose", async () => {
		expect(await audit(records([merge({ files: ["src/stats/index.ts", "docs/stats.md"] })]))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "inside-another-claim", detail: "docs/stats.md was claimed by docs-3c4d (agent-b) at r2" },
		]);
	});

	it("reports, once, a merge that doesn't declare its change or the claims it checked", async () => {
		expect(await audit(records([merge({ change: undefined, claimsTip: undefined, files: ["a.ts", "b.ts"] })]))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "undeclared", detail: "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)" },
		]);
	});

	it("reports, once, a merge citing a registry tip the registry never had", async () => {
		expect(await audit(records([merge({ claimsTip: "made-up" })]))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unknown-claims", detail: "made-up is not in the claims registry's history" },
		]);
	});

	it("reports a merge without the required approvals, or despite a veto, at the votes it cites", async () => {
		const vetoed = { tip: "v2", state: { votes: [...votes[0].state.votes, { ...approve("rev-3", "security"), verdict: "reject" as const }] } };
		expect(await audit({ ...records([merge({ head: "h2" })]) })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h2 had 0 of 2 approvals at v1" },
		]);
		expect(await audit({ ...records([merge({ votesTip: "v2" })]), votes: [...votes, vetoed] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 was vetoed by rev-3 at v2" },
		]);
	});

	it("reports a merge made after its own claim was released (citing an old tip)", async () => {
		const releasedA = { change: "stats-1a2b", agent: "agent-a", by: "agent-a", at: "", reason: "gave up", lastActive: claimA.active };
		const history = [...registry, { tip: "r3", state: at([claimB], [releasedA]) }];
		expect(await audit(records([merge({ claimsTip: "r2" })], history))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "released-before-merge", detail: "stats-1a2b's claim was released at r3 without naming m1 as its merge" },
		]);
		// Released after this merge, naming it: fine.
		const afterMerge = [...registry, { tip: "r3", state: at([claimB], [{ ...releasedA, mergedAs: "m1" }]) }];
		expect(await audit(records([merge({ claimsTip: "r2" })], afterMerge))).toEqual([]);
	});

	it("reports another agent releasing a claim that wasn't stale", async () => {
		const takenEarly = { change: "docs-3c4d", agent: "agent-b", by: "agent-a", at: "2026-10-05T10:05:00.000Z", reason: "stale", stale: true, lastActive: claimB.active };
		const history = [...registry, { tip: "r3", state: at([claimA], [takenEarly]) }];
		expect(await audit({ ...records([], history), staleAfterMs: 30 * 60_000 })).toEqual([
			{ commit: "r3", author: "agent-a", rule: "released-others-claim", detail: "agent-a released docs-3c4d (agent-b), active 5 minutes before, not stale" },
		]);
	});

	it("reports a merge that records no checks, or checks run on a different main, when checks are configured", async () => {
		const withChecks = (m: MergeRecord) => ({ ...records([m]), verify: ["npm test"] });
		expect(await audit(withChecks(merge({ base: "p1" })))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "untested", detail: "the merge records no checks run (Blueprint-Tested)" },
		]);
		expect(await audit(withChecks(merge({ base: "p1", testedOn: "p0" })))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "untested", detail: "checks ran on p0, but the merge went onto p1" },
		]);
		expect(await audit(withChecks(merge({ base: "p1", testedOn: "p1" })))).toEqual([]);
	});
});
