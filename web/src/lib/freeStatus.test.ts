import { describe, expect, it } from "vitest";
import { freeSnapshot } from "../test/fixtures";
import { claimAgent, claimApprovalLabel, claimTitle, freeClaimStatus, votesForClaim } from "./freeStatus";

const claim = freeSnapshot.claims[0];

describe("coordinator-free changes", () => {
	it("derives a claim's status from its head, approvals and hosted agents", () => {
		expect(freeClaimStatus(claim).kind).toBe("changes-requested");
		expect(freeClaimStatus({ ...claim, hosted: undefined }).kind).toBe("in-review");
		expect(freeClaimStatus({ ...claim, head: null, hosted: undefined }).kind).toBe("draft");
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
