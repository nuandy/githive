import { describe, expect, it } from "vitest";
import { audit, type MergeRecord } from "../src/toolkit/audit";
import type { Registry } from "../src/toolkit/claims";
import type { Votes } from "../src/toolkit/votes";

// Nothing stops an agent from breaking a convention, so the audit replays the
// records and reports every violation, with the commit and the agent
// responsible.

const at = (claims: Registry["claims"], released: Registry["released"] = []): Registry => ({ claims, released });
const claimA = {
	change: "stats-1a2b",
	agent: "agent-a",
	paths: ["src/stats/"],
	intent: "Add stats",
	since: "",
	active: "2026-10-05T10:00:00.000Z",
};
const claimB = {
	change: "docs-3c4d",
	agent: "agent-b",
	paths: ["docs/"],
	intent: "Docs",
	since: "",
	active: "2026-10-05T10:00:00.000Z",
};
// The registry's history, oldest first: a's claim, then b's too.
const registry = [
	{ tip: "r1", state: at([claimA]) },
	{ tip: "r2", state: at([claimA, claimB]) },
];
const approve = (reviewer: string, role: string, commit = "h1") => ({
	commit,
	reviewer,
	role,
	verdict: "approve" as const,
	evidence: "ok",
	at: "",
});
const policy = { required: 2, vetoes: ["security"], grants: { security: ["rev-2", "rev-3"] } };
// The votes' history: two approvals of a's head h1.
const votes: { tip: string; state: Votes }[] = [
	{ tip: "v1", state: { votes: [approve("rev-1", "tests"), approve("rev-2", "security")] } },
];
const merge = (overrides: Partial<MergeRecord>): MergeRecord => ({
	commit: "m1",
	author: "agent-a",
	change: "stats-1a2b",
	claimsTip: "r2",
	head: "h1",
	votesTip: "v1",
	files: ["src/stats/index.ts"],
	...overrides,
});
const records = (merges: MergeRecord[], reg = registry) => ({ registry: reg, votes, policy, merges });

describe("the audit", () => {
	it("reports a merge that landed before a change its claim waited on (after), on the same branch", async () => {
		const waiting = [
			{ tip: "r1", state: at([claimB]) },
			{ tip: "r2", state: at([{ ...claimA, after: ["docs-3c4d"] }, claimB]) },
		];
		const docs = merge({ commit: "m0", author: "agent-b", change: "docs-3c4d", files: ["docs/x.md"] });
		const dependencyRule = async (merges: MergeRecord[]) =>
			(await audit(records(merges, waiting))).filter((v) => v.rule === "merged-before-dependency");
		expect(await dependencyRule([merge({})])).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "merged-before-dependency",
				detail: "stats-1a2b waits on docs-3c4d, which hadn't merged into the project's branch before it",
			},
		]);
		expect(await dependencyRule([docs, merge({})])).toEqual([]);
		// Merged first, but on another branch, so it doesn't count.
		expect(await dependencyRule([{ ...docs, branch: "feature/docs" }, merge({})])).toHaveLength(1);
	});

	it("finds nothing wrong with a merge inside its own claim", async () => {
		expect(await audit(records([merge({})]))).toEqual([]);
	});

	it("reports a merge that changed files outside its claim", async () => {
		expect(await audit(records([merge({ files: ["src/stats/index.ts", "src/router.ts"] })]))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "outside-claim",
				detail: "src/router.ts was not in stats-1a2b's claim at r2",
			},
		]);
	});

	it("reports a merge that edited inside another change's claim, naming whose", async () => {
		expect(await audit(records([merge({ files: ["src/stats/index.ts", "docs/stats.md"] })]))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "inside-another-claim",
				detail: "docs/stats.md was claimed by docs-3c4d (agent-b) at r2",
			},
		]);
	});

	it("reports, once, a merge that doesn't declare its change or the claims it checked", async () => {
		expect(await audit(records([merge({ change: undefined, claimsTip: undefined, files: ["a.ts", "b.ts"] })]))).toEqual(
			[
				{
					commit: "m1",
					author: "agent-a",
					rule: "undeclared",
					detail: "the merge names no change or claims it checked (GitHive-Change, GitHive-Claims)",
				},
			],
		);
	});

	it("reports, once, a merge citing a registry tip the registry never had", async () => {
		expect(await audit(records([merge({ claimsTip: "made-up" })]))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "unknown-claims",
				detail: "made-up is not in the claims registry's history",
			},
		]);
	});

	it("reports a merge without the required approvals, or despite a veto, at the votes it cites", async () => {
		const vetoed = {
			tip: "v2",
			state: { votes: [...votes[0].state.votes, { ...approve("rev-3", "security"), verdict: "reject" as const }] },
		};
		expect(await audit({ ...records([merge({ head: "h2" })]) })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h2 had 0 of 2 approvals at v1" },
		]);
		expect(await audit({ ...records([merge({ votesTip: "v2" })]), votes: [...votes, vetoed] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 was vetoed by rev-3 at v2" },
		]);
	});

	it("reports a merge whose approvals came from its author, or from one identity under two names", async () => {
		const self = { tip: "v3", state: { votes: [approve("agent-a", "tests"), approve("rev-2", "security")] } };
		expect(await audit({ ...records([merge({ votesTip: "v3" })]), votes: [self] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 had 1 of 2 approvals at v3" },
		]);
		const twice = {
			tip: "v4",
			state: {
				votes: [
					{ ...approve("rev-1", "tests"), by: "service:x/agent-z" },
					{ ...approve("rev-2", "security"), by: "service:x/agent-z" },
				],
			},
		};
		expect(await audit({ ...records([merge({ votesTip: "v4" })]), votes: [twice] })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 had 1 of 2 approvals at v4" },
		]);
	});

	it("reports a merge made after its own claim was released (citing an old tip)", async () => {
		const releasedA = {
			change: "stats-1a2b",
			agent: "agent-a",
			by: "agent-a",
			at: "",
			reason: "gave up",
			lastActive: claimA.active,
		};
		const history = [...registry, { tip: "r3", state: at([claimB], [releasedA]) }];
		expect(await audit(records([merge({ claimsTip: "r2" })], history))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "released-before-merge",
				detail: "stats-1a2b's claim was released at r3 without naming m1 as its merge",
			},
		]);
		// Released after this merge and naming it, which is allowed.
		const afterMerge = [...registry, { tip: "r3", state: at([claimB], [{ ...releasedA, mergedAs: "m1" }]) }];
		expect(await audit(records([merge({ claimsTip: "r2" })], afterMerge))).toEqual([]);
	});

	it("reports another agent releasing a claim that wasn't stale", async () => {
		const takenEarly = {
			change: "docs-3c4d",
			agent: "agent-b",
			by: "agent-a",
			at: "2026-10-05T10:05:00.000Z",
			reason: "stale",
			stale: true,
			lastActive: claimB.active,
		};
		const history = [...registry, { tip: "r3", state: at([claimA], [takenEarly]) }];
		expect(await audit({ ...records([], history), staleAfterMs: 30 * 60_000 })).toEqual([
			{
				commit: "r3",
				author: "agent-a",
				rule: "released-others-claim",
				detail: "agent-a released docs-3c4d (agent-b), active 5 minutes before, not stale",
			},
		]);
	});

	it("reports a merge that records no checks, or checks of a different main, when checks are configured", async () => {
		const withChecks = (m: MergeRecord) => ({ ...records([m]), verify: ["npm test"] });
		expect(await audit(withChecks(merge({ base: "p1" })))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "untested", detail: "the merge records no checks run (GitHive-Tested)" },
		]);
		expect(await audit(withChecks(merge({ base: "p1", testedOn: "p0" })))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "untested", detail: "checks ran on p0, but the merge went onto p1" },
		]);
		expect(await audit(withChecks(merge({ base: "p1", testedOn: "p1" })))).toEqual([]);
	});

	it("holds each merge to the settings in force at the registry state it cites", async () => {
		// At r3 the policy was raised to 3 approvals and checks were added. A merge citing r2 came before that.
		const raised = [
			...registry,
			{ tip: "r3", state: { ...at([claimA, claimB]), policy: { ...policy, required: 3 }, verify: ["npm test"] } },
		];
		expect(await audit(records([merge({ claimsTip: "r2" })], raised))).toEqual([]);
		expect(await audit(records([merge({ claimsTip: "r3" })], raised))).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 had 2 of 3 approvals at v1" },
			{ commit: "m1", author: "agent-a", rule: "untested", detail: "the merge records no checks run (GitHive-Tested)" },
		]);
	});
});

describe("the audit, with sharded claims", () => {
	// With claims split by path, a merge cites each shard it checked as shard=tip.
	const wideOther = {
		change: "src-9z9z",
		agent: "agent-z",
		paths: ["src/"],
		intent: "Everything in src",
		since: "",
		active: "2026-10-05T10:00:00.000Z",
	};
	const root = [{ tip: "r0", state: { ...at([]), baseline: "b0", shardDepth: 2 } }];
	const shards = new Map([
		["src/stats", [{ tip: "s1", state: at([claimA]) }]],
		["src", [{ tip: "w1", state: at([wideOther]) }]],
	]);
	const sharded = (merges: MergeRecord[], history = shards) => ({
		registry: root,
		shards: history,
		votes,
		policy,
		merges,
	});

	it("finds nothing wrong with a merge inside its own claim, citing its shard", async () => {
		expect(await audit(sharded([merge({ claimsTip: "src%2Fstats=s1" })]))).toEqual([]);
	});

	it("holds a merge to the settings in the registry state it cites among its shards", async () => {
		const raised = [...root, { tip: "r1", state: { ...root[0].state, policy: { ...policy, required: 3 } } }];
		expect(await audit({ ...sharded([merge({ claimsTip: "=r1 src%2Fstats=s1" })]), registry: raised })).toEqual([
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 had 2 of 3 approvals at v1" },
		]);
	});

	it("checks a merge against every shard it cites, a wide claim above included", async () => {
		expect(await audit(sharded([merge({ claimsTip: "src=w1 src%2Fstats=s1" })]))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "inside-another-claim",
				detail: "src/stats/index.ts was claimed by src-9z9z (agent-z) at src=w1 src%2Fstats=s1",
			},
		]);
	});

	it("reports a file no cited shard covers, and a cited tip its shard never had", async () => {
		expect(
			await audit(sharded([merge({ claimsTip: "src%2Fstats=s1", files: ["src/stats/a.ts", "lib/x.ts"] })])),
		).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "unknown-claims",
				detail: "lib/x.ts: the merge cites no claims shard covering it",
			},
		]);
		expect(await audit(sharded([merge({ claimsTip: "src%2Fstats=made-up" })]))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "unknown-claims",
				detail: "src/stats@made-up is not in that shard's history",
			},
		]);
	});

	it("reports a merge made after its claim was released in a shard it cites", async () => {
		const releasedA = {
			change: "stats-1a2b",
			agent: "agent-a",
			by: "agent-a",
			at: "",
			reason: "gave up",
			lastActive: claimA.active,
		};
		const history = new Map([
			...shards,
			[
				"src/stats",
				[
					{ tip: "s1", state: at([claimA]) },
					{ tip: "s2", state: at([], [releasedA]) },
				],
			],
		]);
		expect(await audit(sharded([merge({ claimsTip: "src%2Fstats=s1" })], history))).toEqual([
			{
				commit: "m1",
				author: "agent-a",
				rule: "released-before-merge",
				detail: "stats-1a2b's claim was released at s2 without naming m1 as its merge",
			},
		]);
	});

	it("reports another agent releasing a claim that wasn't stale, in any shard", async () => {
		const takenEarly = {
			change: "src-9z9z",
			agent: "agent-z",
			by: "agent-a",
			at: "2026-10-05T10:05:00.000Z",
			reason: "stale",
			stale: true,
			lastActive: wideOther.active,
		};
		const history = new Map([
			...shards,
			[
				"src",
				[
					{ tip: "w1", state: at([wideOther]) },
					{ tip: "w2", state: at([], [takenEarly]) },
				],
			],
		]);
		expect(await audit({ ...sharded([], history), staleAfterMs: 30 * 60_000 })).toEqual([
			{
				commit: "w2",
				author: "agent-a",
				rule: "released-others-claim",
				detail: "agent-a released src-9z9z (agent-z), active 5 minutes before, not stale",
			},
		]);
	});
});
