import { describe, expect, it } from "vitest";
import type { MergeCheck, RepoLanding, RepoSnapshot } from "../api";
import { ago } from "../test/fixtures";
import type { Claim, Vote } from "./claimStatus";
import {
	checksFor,
	conflictOf,
	landQuestion,
	landable,
	landsWith,
	latestCheck,
	mayVoteAs,
	primaryAction,
	readerVote,
	roleLines,
	roleSaying,
	voteRoles,
} from "./decision";

// What the decision box on a change's page works out: who approved as each role it needs, its latest check, whether it
// conflicts with its branch, what lands with it, and the one thing the reader can do next.

const HEAD = "4e6df04aa1b2c3d4e5f6";
const policy: RepoSnapshot["policy"] = {
	required: 2,
	vetoes: ["security"],
	escalate: [{ paths: ["src/payments/"], vetoes: ["payments"] }],
	grants: { security: ["person:*", "githive"], payments: ["@acme/payments"], legal: ["person:lee"] },
};

const claim = (over: Partial<Claim> = {}): Claim => ({
	change: "checkout-tax",
	agent: "ines/claude",
	paths: ["src/lib/currency.ts"],
	intent: "Show tax",
	since: ago(140),
	active: ago(25),
	head: HEAD,
	approval: { approved: false, approvals: 1, required: 2, vetoedBy: [], awaiting: ["security"] },
	...over,
});

const vote = (over: Partial<Vote>): Vote => ({
	commit: HEAD,
	reviewer: "robin/reviewer",
	role: "review",
	verdict: "approve",
	evidence: "Checked the totals.",
	at: ago(30),
	...over,
});

const snapshot = (claims: Claim[], votes: Vote[] = []): RepoSnapshot => ({
	repo: "acme/storefront",
	policy,
	verify: ["npm test"],
	verified: true,
	branch: "main",
	branchRules: [{ pattern: "release/*", verify: ["npm ci", "npm run e2e"] }],
	claims,
	votes,
});

describe("approvals per role", () => {
	it("counts approvals for review and names who gave them, and each blocking role with who approved as it", () => {
		const votes = [
			vote({}),
			vote({ reviewer: "githive-guard", role: "security", at: ago(20) }),
			vote({ reviewer: "ines/claude", at: ago(10) }),
			vote({ reviewer: "githive-checks", role: "checks", verdict: "reject" }),
			vote({ reviewer: "devon/codex", commit: "0ld0ld0ld0ld" }),
		];
		// Every approval counts toward review's, the security reviewer's too; its agent's own doesn't.
		const approved = claim({ approval: { approved: true, approvals: 2, required: 2, vetoedBy: [], awaiting: [] } });
		const lines = roleLines(approved, votes, policy);
		expect(lines).toEqual([
			{
				role: "review",
				needed: 2,
				approvals: 2,
				approvedBy: ["robin/reviewer", "githive-guard"],
				blockedBy: [],
				done: true,
			},
			{ role: "security", needed: 1, approvals: 1, approvedBy: ["githive-guard"], blockedBy: [], done: true },
		]);
		expect(lines.map((line) => roleSaying(line))).toEqual([
			{ text: "robin/reviewer, githive-guard", mark: "✓" },
			{ text: "githive-guard", mark: "✓" },
		]);
		const waiting = claim();
		expect(roleSaying(roleLines(waiting, [vote({})], policy)[0]!)).toEqual({
			text: "1 of 2 · robin/reviewer",
			mark: null,
		});
		expect(roleSaying(roleLines(waiting, [], policy)[1]!)).toEqual({ text: "waiting", mark: null });
	});

	it("adds the roles a change's paths call for, says who blocked, and who is still at work", () => {
		const paying = claim({
			paths: ["src/payments/refunds.ts"],
			approval: { approved: false, approvals: 2, required: 2, vetoedBy: ["githive-guard"], awaiting: ["payments"] },
			hosted: { reviewers: [{ role: "payments", status: "working" }] },
		});
		const votes = [
			vote({}),
			vote({ reviewer: "theo/cursor" }),
			vote({ reviewer: "githive-guard", role: "security", verdict: "reject" }),
		];
		const lines = roleLines(paying, votes, policy);
		expect(lines.map((line) => [line.role, roleSaying(line)])).toEqual([
			["review", { text: "robin/reviewer, theo/cursor", mark: "✓" }],
			["security", { text: "blocked by githive-guard", mark: "×" }],
			["payments", { text: "GitHive's reviewer is at work", mark: null }],
		]);
	});

	it("says what GitHive's reviewer for a role found, before its vote counts", () => {
		const reviewed = (verdict: string) =>
			roleLines(claim({ hosted: { reviewers: [{ role: "security", status: "done", verdict }] } }), [], policy)[1]!;
		expect(roleSaying(reviewed("reject"))).toEqual({ text: "GitHive's reviewer asked for changes", mark: "×" });
		expect(roleSaying(reviewed("approve"))).toEqual({ text: "GitHive's reviewer approved", mark: "✓" });
	});

	it("says a person's own vote is theirs, and never shows a person's hash", () => {
		const votes = [vote({ reviewer: "person:abc123", by: "person:abc123" }), vote({ reviewer: "person:def456" })];
		const [review] = roleLines(claim(), votes, policy);
		expect(roleSaying(review!, { by: "person:abc123" }).text).toBe("1 of 2 · you, a person");
	});

	it("has nothing to say for GitHub's trusted changes", () => {
		expect(roleLines(claim({ trusted: "GitHub's" }), [], policy)).toEqual([]);
	});
});

describe("the latest check", () => {
	const landing = (over: Partial<RepoLanding> = {}): RepoLanding => ({
		branch: "main",
		checking: null,
		recent: [],
		...over,
	});

	it("is running while the head is in the batch being checked", () => {
		const checking = {
			base: "b",
			since: ago(3),
			changes: [{ change: "checkout-tax", head: HEAD, agent: "ines/claude" }],
		};
		expect(latestCheck(claim(), [], landing({ checking }))).toEqual({ kind: "running", since: ago(3) });
	});

	it("is the newest result on the head, from the checks' vote or the landing, with its evidence", () => {
		const failedVote = vote({
			reviewer: "githive-checks",
			role: "checks",
			verdict: "reject",
			evidence: "npm test exited 1",
		});
		expect(latestCheck(claim(), [failedVote], landing())).toEqual({
			kind: "failed",
			evidence: "npm test exited 1",
			at: failedVote.at,
		});
		const recent = [
			{
				change: "checkout-tax",
				head: HEAD,
				agent: "ines/claude",
				how: "failed" as const,
				at: ago(5),
				reasons: ["checks failed: lint"],
			},
		];
		expect(latestCheck(claim(), [failedVote], landing({ recent }))).toEqual({
			kind: "failed",
			evidence: "checks failed: lint",
			at: ago(5),
		});
	});

	it("is nothing yet for an earlier push's result, or none at all", () => {
		const older = vote({ commit: "0ld0ld0ld0ld", reviewer: "githive-checks", role: "checks", verdict: "reject" });
		expect(latestCheck(claim(), [older], landing())).toEqual({ kind: "none" });
		expect(latestCheck(claim({ head: null }), [], undefined)).toEqual({ kind: "none" });
	});

	it("lists the branch's checks: the repo's, or its branch rule's", () => {
		expect(checksFor(snapshot([]), "main")).toEqual(["npm test"]);
		expect(checksFor(snapshot([]), "release/2.4")).toEqual(["npm ci", "npm run e2e"]);
		expect(checksFor(snapshot([]), "experiments/x")).toEqual(["npm test"]);
	});
});

describe("a conflict with its branch", () => {
	const merge = (over: Partial<MergeCheck> = {}): MergeCheck => ({
		head: HEAD,
		into: "main",
		branchHead: "9f8e7d6c",
		clean: false,
		conflicts: ["src/pages/Home.tsx"],
		...over,
	});

	it("counts only what was found on its head", () => {
		expect(conflictOf(claim(), merge())).toEqual({ kind: "conflicts", into: "main", files: ["src/pages/Home.tsx"] });
		expect(conflictOf(claim(), merge({ clean: true, conflicts: [] }))).toEqual({ kind: "clean", into: "main" });
		expect(conflictOf(claim(), merge({ head: "0ld0ld0ld0ld" }))).toEqual({ kind: "unknown", into: "main" });
		expect(conflictOf(claim(), undefined)).toEqual({ kind: "unknown", into: "main" });
	});
});

describe("landing", () => {
	const approved = (change: string, over: Partial<Claim> = {}) =>
		claim({
			change,
			head: `${change}-head`,
			since: ago(100),
			approval: { approved: true, approvals: 2, required: 2, vetoedBy: [], awaiting: [] },
			...over,
		});

	it("lands with the branch's other ready changes: approved, clean, not waiting, not already landing", () => {
		const own = approved("checkout-tax");
		const others = [
			approved("footer-links", { since: ago(50) }),
			approved("product-reviews", { since: ago(110) }),
			approved("checks-failed"),
			approved("waiting", { waitsOn: ["search"] }),
			approved("in-batch"),
			approved("backport", { into: "release/2.4" }),
			claim({ change: "unapproved" }),
		];
		const votes = [
			vote({ commit: "checks-failed-head", reviewer: "githive-checks", role: "checks", verdict: "reject" }),
		];
		const checking = { base: "b", since: ago(1), changes: [{ change: "in-batch", head: "in-batch-head", agent: "x" }] };
		const batch = landsWith(own, snapshot([own, ...others], votes), { branch: "main", checking, recent: [] });
		expect(batch.map((each) => each.change)).toEqual(["product-reviews", "footer-links"]);
		expect(landQuestion(own.change, batch, ["npm test"])).toBe(
			"Land checkout-tax now? It lands with product-reviews and footer-links, after npm test.",
		);
		expect(landQuestion(own.change, [], [])).toBe("Land checkout-tax now? It lands on its own, with no checks to run.");
		expect(landQuestion(own.change, batch.slice(0, 1), ["npm ci", "npm test", "npm run e2e"])).toBe(
			"Land checkout-tax now? It lands with product-reviews, after npm ci, npm test and npm run e2e.",
		);
	});

	it("is offered only for an approved change that waits on nothing, with a clean head, not landing yet", () => {
		const own = approved("checkout-tax", { head: HEAD });
		expect(landable(own, [], {})).toBe(true);
		expect(landable(own, [vote({ verdict: "reject", reviewer: "theo/cursor" })], {})).toBe(false);
		expect(landable({ ...own, waitsOn: ["x"] }, [], {})).toBe(false);
		const merge = { head: HEAD, into: "main", branchHead: "b", clean: false, conflicts: ["a.ts"] };
		expect(landable(own, [], { merge })).toBe(false);
		const checking = { base: "b", since: ago(1), changes: [{ change: own.change, head: HEAD, agent: "x" }] };
		expect(landable(own, [], { landing: { checking } })).toBe(false);
		expect(landable(claim(), [], {})).toBe(false);
	});
});

describe("the reader's part", () => {
	it("finds the reader's own vote on the head", () => {
		const mine = vote({ reviewer: "person:abc", by: "person:abc", at: ago(2) });
		const votes = [vote({}), vote({ reviewer: "person:abc", by: "person:abc", at: ago(9) }), mine];
		expect(readerVote(claim(), votes, "person:abc")).toEqual(mine);
		expect(readerVote(claim(), votes, undefined)).toBeUndefined();
		expect(
			readerVote(claim(), [vote({ reviewer: "person:abc", commit: "0ld0ld0ld0ld" })], "person:abc"),
		).toBeUndefined();
	});

	it("offers one action: land when it can, else a vote the reader hasn't given, else nothing", () => {
		expect(primaryAction({ landable: true, voter: true, voted: false })).toBe("land");
		expect(primaryAction({ landable: false, voter: true, voted: false })).toBe("vote");
		expect(primaryAction({ landable: false, voter: true, voted: true })).toBeNull();
		expect(primaryAction({ landable: false, voter: false, voted: false })).toBeNull();
	});

	it("knows which roles a person may vote as, from the grants, their identity and their teams", () => {
		const reader = { by: "person:lee", teams: ["@acme/web"] };
		expect(mayVoteAs(policy, "review", reader)).toBe(true);
		expect(mayVoteAs(policy, "security", reader)).toBe(true);
		expect(mayVoteAs(policy, "legal", reader)).toBe(true);
		expect(mayVoteAs(policy, "payments", reader)).toBe(false);
		expect(mayVoteAs(policy, "payments", { ...reader, teams: ["@acme/payments"] })).toBe(true);
		// Without who they are, only a role granted to every person is known to be theirs.
		expect(mayVoteAs(policy, "security", {})).toBe(true);
		expect(mayVoteAs(policy, "payments", {})).toBeNull();
		expect(mayVoteAs({ ...policy, grants: { security: ["githive"] } }, "security", reader)).toBe(false);
	});

	it("offers the roles this change needs that the reader holds, or every one marked when it can't tell", () => {
		const paying = claim({ paths: ["src/payments/refunds.ts"] });
		expect(voteRoles(policy, paying, { by: "person:lee", teams: [] })).toEqual({
			roles: [
				{ role: "review", granted: true },
				{ role: "security", granted: true },
			],
			exact: true,
		});
		expect(voteRoles(policy, paying, {})).toEqual({
			roles: [
				{ role: "review", granted: true },
				{ role: "security", granted: true },
				{ role: "payments", granted: null },
			],
			exact: false,
		});
		expect(voteRoles(policy, claim(), { by: "person:lee" }).roles.map((each) => each.role)).toEqual([
			"review",
			"security",
		]);
	});
});
