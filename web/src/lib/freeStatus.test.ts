import { describe, expect, it } from "vitest";
import { freeSnapshot } from "../test/fixtures";
import { claimAgent, claimApprovalLabel, claimTitle, freeClaimStatus, votesForClaim, shardingSummary, votesShardingSummary, recordsBadge } from "./freeStatus";

const claim = freeSnapshot.claims[0];

describe("coordinator-free changes", () => {
	it("derives a claim's status from its head, approvals and hosted agents", () => {
		expect(freeClaimStatus(claim).kind).toBe("changes-requested");
		expect(freeClaimStatus({ ...claim, hosted: undefined }).kind).toBe("in-review");
		expect(freeClaimStatus({ ...claim, head: null, hosted: undefined }).kind).toBe("draft");
		// An agent asked a person: that comes first.
		expect(freeClaimStatus({ ...claim, attention: { reason: "reviewers disagree", agent: "agent-c", at: "" } })).toMatchObject({ kind: "needs-you", description: "agent-c asks you: reviewers disagree" });
		expect(freeClaimStatus({ ...claim, approval: { ...claim.approval, approved: true }, hosted: undefined }).kind).toBe("approved");
		expect(freeClaimStatus({ ...claim, approval: { ...claim.approval, vetoedBy: ["security"] } })).toMatchObject({ label: "Changes requested", description: "Blocked by security." });
		expect(freeClaimStatus({ ...claim, hosted: { builder: { status: "failed", revisions: 0, error: "boom" }, reviewers: [] } })).toMatchObject({ kind: "needs-you", description: "The builder failed: boom" });
	});

	it("waits for the roles that can block before calling a claim approved", () => {
		const waiting = { ...claim, hosted: undefined, approval: { approved: false, approvals: 2, required: 2, vetoedBy: [], awaiting: ["security"] } };
		expect(freeClaimStatus(waiting)).toMatchObject({ kind: "in-review", description: "Waiting for security, which can block it." });
		expect(claimApprovalLabel(waiting)).toBe("Waiting for security");
		expect(claimApprovalLabel(claim)).toBe("1/2 approvals");
		// Older servers don't send `awaiting`.
		expect(claimApprovalLabel({ ...claim, approval: { approved: false, approvals: 2, required: 2, vetoedBy: [] } })).toBe("2/2 approvals");
	});

	it("names and titles a claim", () => {
		expect(claimTitle(claim)).toBe("Rewrite the C section");
		expect(claimTitle({ ...claim, intent: "" })).toBe("c-1");
		expect(claimAgent(claim)).toBe("agent-c");
		expect(claimAgent({ ...claim, agent: "" })).toBe("agent-c");
	});

	it("finds the votes on a claim's current head, short or long", () => {
		expect(votesForClaim(claim, freeSnapshot.votes)).toHaveLength(1);
		expect(votesForClaim({ ...claim, head: "b1c2d3e4" }, freeSnapshot.votes)).toHaveLength(1);
		expect(votesForClaim({ ...claim, head: null }, freeSnapshot.votes)).toEqual([]);
		expect(votesForClaim(claim, [{ ...freeSnapshot.votes[0], commit: "" }])).toEqual([]);
	});
});

describe("how a repo keeps its claims", () => {
	it("says one record while sharding is on demand or off, and when and why once sharded", () => {
		expect(shardingSummary({})).toBeNull();
		expect(shardingSummary({ sharding: "on demand" })).toMatchObject({ label: "One claims record", sharded: false, detail: expect.stringMatching(/automatically once 8 agents hold claims/) });
		expect(shardingSummary({ sharding: "never" })).toMatchObject({ label: "One claims record", sharded: false, detail: expect.stringMatching(/never to shard/) });
		const sharded = shardingSummary({ sharding: { since: "2026-10-07T09:30:00.000Z", because: "8 agents hold claims" }, shardDepth: 2 });
		expect(sharded).toMatchObject({ label: "Sharded claims", sharded: true });
		expect(sharded?.detail).toMatch(/sharded by path, 2 folders deep since .*2026.* \(8 agents hold claims\)/);
	});
});

describe("how a repo keeps its votes", () => {
	it("says one record on demand, and when and why once split by commit", () => {
		expect(votesShardingSummary({})).toBeNull();
		expect(votesShardingSummary({ votesSharding: "on demand" })).toMatchObject({ sharded: false, detail: expect.stringMatching(/automatically once 8 reviewers vote/) });
		expect(votesShardingSummary({ votesSharding: { since: "2026-10-07T09:30:00.000Z", because: "8 reviewers voting" } })?.detail).toMatch(/split by commit since .*2026.* \(8 reviewers voting\)/);
	});

	it("names what's sharded in the header badge, and says both in its detail", () => {
		const sharded = { since: "2026-10-07T09:30:00.000Z" };
		expect(recordsBadge({ sharding: "on demand", votesSharding: "on demand" })).toMatchObject({ label: "One claims record", sharded: false, detail: expect.stringMatching(/Claims are kept.*Votes are kept/) });
		expect(recordsBadge({ sharding: sharded, votesSharding: "on demand" })).toMatchObject({ label: "Sharded claims", sharded: true });
		expect(recordsBadge({ sharding: "on demand", votesSharding: sharded })).toMatchObject({ label: "Sharded votes", sharded: true });
		expect(recordsBadge({ sharding: sharded, votesSharding: sharded })).toMatchObject({ label: "Sharded claims & votes", sharded: true });
		expect(recordsBadge({})).toBeNull();
	});
});
