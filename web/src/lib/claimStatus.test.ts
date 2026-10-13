import { describe, expect, it } from "vitest";
import { repoSnapshot } from "../test/fixtures";
import {
	claimAgent,
	claimApprovalLabel,
	claimTitle,
	claimStatus,
	votesForClaim,
	shardingSummary,
	votesShardingSummary,
	recordsBadge,
	type Vote,
} from "./claimStatus";

const claim = repoSnapshot.claims[0]!;

describe("changes", () => {
	it("derives a claim's status from its head, approvals and hosted agents", () => {
		expect(claimStatus(claim).kind).toBe("changes-requested");
		expect(claimStatus({ ...claim, hosted: undefined }).kind).toBe("in-review");
		expect(claimStatus({ ...claim, head: null, hosted: undefined })).toMatchObject({
			kind: "building",
			label: "Building",
		});
		// An agent asked a person: that comes first.
		expect(
			claimStatus({ ...claim, attention: { reason: "reviewers disagree", agent: "agent-c", at: "" } }),
		).toMatchObject({
			kind: "needs-person",
			label: "Needs a person",
			tone: "bad",
			description: "agent-c asks a person: reviewers disagree",
		});
		expect(claimStatus({ ...claim, approval: { ...claim.approval, approved: true }, hosted: undefined }).kind).toBe(
			"approved",
		);
		expect(claimStatus({ ...claim, approval: { ...claim.approval, vetoedBy: ["security"] } })).toMatchObject({
			label: "Changes requested",
			description: "Blocked by security.",
		});
		expect(
			claimStatus({ ...claim, hosted: { builder: { status: "failed", revisions: 0, error: "boom" }, reviewers: [] } }),
		).toMatchObject({ kind: "needs-person", description: "GitHive's builder failed: boom" });
	});

	it("waits for the roles that can block before calling a claim approved", () => {
		const waiting = {
			...claim,
			hosted: undefined,
			approval: { approved: false, approvals: 2, required: 2, vetoedBy: [], awaiting: ["security"] },
		};
		expect(claimStatus(waiting)).toMatchObject({
			kind: "in-review",
			label: "In review",
			tone: "accent",
			description: "Waiting for security, which can block it.",
		});
		// A role only people may vote as needs a person.
		const people = { required: 2, vetoes: ["security"], grants: { security: ["person:*"] } };
		expect(claimStatus(waiting, [], { policy: people })).toMatchObject({
			kind: "needs-person",
			description: "Waiting for a security vote, which only a person can give.",
		});
		expect(claimApprovalLabel(waiting)).toBe("Waiting for security");
		expect(claimApprovalLabel(claim)).toBe("1/2 approvals");
		// Older servers don't send `awaiting`.
		expect(
			claimApprovalLabel({ ...claim, approval: { approved: false, approvals: 2, required: 2, vetoedBy: [] } }),
		).toBe("2/2 approvals");
	});

	it("names and titles a claim", () => {
		expect(claimTitle(claim)).toBe("Rewrite the C section");
		expect(claimTitle({ ...claim, intent: "" })).toBe("c-1");
		expect(claimAgent(claim)).toBe("agent-c");
		expect(claimAgent({ ...claim, agent: "" })).toBe("agent-c");
	});

	it("finds the votes on a claim's current head, short or long", () => {
		expect(votesForClaim(claim, repoSnapshot.votes)).toHaveLength(1);
		expect(votesForClaim({ ...claim, head: "b1c2d3e4" }, repoSnapshot.votes)).toHaveLength(1);
		expect(votesForClaim({ ...claim, head: null }, repoSnapshot.votes)).toEqual([]);
		expect(votesForClaim(claim, [{ ...repoSnapshot.votes[0]!, commit: "" }])).toEqual([]);
	});
});

describe("rejections on the change's head", () => {
	const approved = { ...claim, hosted: undefined, approval: { ...claim.approval, approved: true, vetoedBy: [] } };
	const head = approved.head!;
	const vote = (over: Partial<Vote>): Vote => ({
		commit: head,
		reviewer: "githive-checks",
		role: "checks",
		verdict: "reject",
		evidence: "checks failed: npm test exited 1",
		at: "2026-10-13T10:00:00Z",
		...over,
	});

	it("reads an approved change whose checks failed on its head as failed, not approved", () => {
		expect(claimStatus(approved, [vote({})])).toMatchObject({
			kind: "checks-failed",
			label: "Checks failed",
			tone: "bad",
		});
	});

	it("reads a reviewer's rejection on the head as changes requested", () => {
		expect(claimStatus(approved, [vote({ reviewer: "ines/claude", role: "review" })]).kind).toBe("changes-requested");
	});

	it("ignores rejections on an earlier head, and the author's own votes", () => {
		expect(claimStatus(approved, [vote({ commit: "0000000old" })]).kind).toBe("approved");
		expect(claimStatus(approved, [vote({ reviewer: approved.agent })]).kind).toBe("approved");
		expect(claimStatus(approved, [vote({ verdict: "approve" })]).kind).toBe("approved");
	});

	it("reads as before without votes", () => {
		expect(claimStatus(approved).kind).toBe("approved");
	});

	it("says it's landing while its head is checked to land", () => {
		const landing = { checking: { base: "m", since: "", changes: [{ change: "c-1", head, agent: "agent-c" }] } };
		expect(claimStatus(approved, [], { landing })).toMatchObject({ kind: "landing", label: "Landing", tone: "warn" });
	});
});

describe("how a repo keeps its claims", () => {
	it("says one record while sharding is on demand or off, and when and why once sharded", () => {
		expect(shardingSummary({})).toBeNull();
		expect(shardingSummary({ sharding: "on demand" })).toMatchObject({
			label: "One claims record",
			sharded: false,
			detail: expect.stringMatching(/automatically once 8 agents hold claims/),
		});
		expect(shardingSummary({ sharding: "never" })).toMatchObject({
			label: "One claims record",
			sharded: false,
			detail: expect.stringMatching(/never to shard/),
		});
		const sharded = shardingSummary({
			sharding: { since: "2026-10-07T09:30:00.000Z", because: "8 agents hold claims" },
			shardDepth: 2,
		});
		expect(sharded).toMatchObject({ label: "Sharded claims", sharded: true });
		expect(sharded?.detail).toMatch(/sharded by path, 2 folders deep since .*2026.* \(8 agents hold claims\)/);
	});
});

describe("how a repo keeps its votes", () => {
	it("says one record on demand, and when and why once split by commit", () => {
		expect(votesShardingSummary({})).toBeNull();
		expect(votesShardingSummary({ votesSharding: "on demand" })).toMatchObject({
			sharded: false,
			detail: expect.stringMatching(/automatically once 8 reviewers vote/),
		});
		expect(
			votesShardingSummary({ votesSharding: { since: "2026-10-07T09:30:00.000Z", because: "8 reviewers voting" } })
				?.detail,
		).toMatch(/split by commit since .*2026.* \(8 reviewers voting\)/);
	});

	it("names what's sharded in the header badge, and says both in its detail", () => {
		const sharded = { since: "2026-10-07T09:30:00.000Z" };
		expect(recordsBadge({ sharding: "on demand", votesSharding: "on demand" })).toMatchObject({
			label: "One claims record",
			sharded: false,
			detail: expect.stringMatching(/Claims are kept.*Votes are kept/),
		});
		expect(recordsBadge({ sharding: sharded, votesSharding: "on demand" })).toMatchObject({
			label: "Sharded claims",
			sharded: true,
		});
		expect(recordsBadge({ sharding: "on demand", votesSharding: sharded })).toMatchObject({
			label: "Sharded votes",
			sharded: true,
		});
		expect(recordsBadge({ sharding: sharded, votesSharding: sharded })).toMatchObject({
			label: "Sharded claims & votes",
			sharded: true,
		});
		expect(recordsBadge({})).toBeNull();
	});
});
