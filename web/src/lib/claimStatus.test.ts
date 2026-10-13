import { describe, expect, it } from "vitest";
import { repoSnapshot } from "../test/fixtures";
import {
	claimAgent,
	claimApprovalLabel,
	claimTitle,
	claimStatus,
	shortTitle,
	votesForClaim,
	shardingSummary,
	votesShardingSummary,
	recordsBadge,
} from "./claimStatus";

const claim = repoSnapshot.claims[0]!;

describe("changes", () => {
	it("derives a claim's status from its head, approvals and hosted agents", () => {
		expect(claimStatus(claim).kind).toBe("changes-requested");
		expect(claimStatus({ ...claim, hosted: undefined }).kind).toBe("in-review");
		expect(claimStatus({ ...claim, head: null, hosted: undefined }).kind).toBe("draft");
		// An agent asked a person: that comes first.
		expect(
			claimStatus({ ...claim, attention: { reason: "reviewers disagree", agent: "agent-c", at: "" } }),
		).toMatchObject({ kind: "needs-you", description: "agent-c asks you: reviewers disagree" });
		expect(claimStatus({ ...claim, approval: { ...claim.approval, approved: true }, hosted: undefined }).kind).toBe(
			"approved",
		);
		expect(claimStatus({ ...claim, approval: { ...claim.approval, vetoedBy: ["security"] } })).toMatchObject({
			label: "Changes requested",
			description: "Blocked by security.",
		});
		expect(
			claimStatus({ ...claim, hosted: { builder: { status: "failed", revisions: 0, error: "boom" }, reviewers: [] } }),
		).toMatchObject({ kind: "needs-you", description: "The builder failed: boom" });
	});

	it("waits for the roles that can block before calling a claim approved", () => {
		const waiting = {
			...claim,
			hosted: undefined,
			approval: { approved: false, approvals: 2, required: 2, vetoedBy: [], awaiting: ["security"] },
		};
		expect(claimStatus(waiting)).toMatchObject({
			kind: "in-review",
			description: "Waiting for security, which can block it.",
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
		const paragraph =
			"BaseServlet calls exactly one controller method per request: do<HttpMethod> (doGet, doPost, ...) when the " +
			"controller defines it, otherwise doMain. Previously every public method starting with \"do\" ran.";
		expect(claimTitle({ ...claim, intent: paragraph })).toBe(
			"BaseServlet calls exactly one controller method per request",
		);
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

const BRIEF =
	"Wire up the game src/main.js: put the game together as README.md describes: today's puzzle, progress loaded and saved after every word, the board, typing and controls.";

describe("a short title", () => {
	it("stops at a colon that ends a lead-in, so a hosted builder's brief doesn't become the headline", () => {
		expect(shortTitle(BRIEF)).toBe("Wire up the game src/main.js");
	});

	it("keeps a label's colon near the start, and stops at the first sentence", () => {
		expect(shortTitle("Fix: an IPv6 Host header loses its port. It drops it.")).toBe(
			"Fix: an IPv6 Host header loses its port",
		);
	});

	it("cuts a long sentence at a word", () => {
		const title = shortTitle(`Add ${"very ".repeat(30)}long tests`);
		expect(title.length).toBeLessThanOrEqual(65);
		expect(title.endsWith("…")).toBe(true);
	});
});
