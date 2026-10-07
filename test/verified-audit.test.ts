import { beforeAll, describe, expect, it } from "vitest";
import { audit, type MergeRecord, mergeStampPayload, revertStampPayload } from "../src/toolkit/audit";
import type { ClaimRecord, Registry } from "../src/toolkit/claims";
import { generateStampKey, makeStamper, stampPayload, type Stamper } from "../src/toolkit/stamp";
import type { VoteRecord, Votes } from "../src/toolkit/votes";

// With a stamp key in the registry, the audit trusts only what GitHive
// stamped: a record or merge without a valid stamp is reported, and an
// unstamped vote doesn't count toward approval.

let key: { privateKey: string; publicKey: string };
let toolkit: Stamper;
/** Each reviewer signs as itself: approvals count per verified identity, never the author's. */
const reviewers = new Map<string, Stamper>();
const policy = { required: 2, vetoes: [] };

beforeAll(async () => {
	key = await generateStampKey();
	toolkit = await makeStamper(key.privateKey, "service:agent-a");
	for (const name of ["rev-1", "rev-2"]) reviewers.set(name, await makeStamper(key.privateKey, `service:${name}`));
});

const stampedClaim = async (record: Omit<ClaimRecord, "by" | "stamp">): Promise<ClaimRecord> => {
	const withBy = { ...record, by: toolkit.by };
	return { ...withBy, stamp: await toolkit.stamp(stampPayload("claim", withBy)) };
};
const stampedVote = async (record: Omit<VoteRecord, "by" | "stamp">): Promise<VoteRecord> => {
	const stamper = reviewers.get(record.reviewer)!;
	const withBy = { ...record, by: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload("vote", withBy)) };
};
const registryAt = (tip: string, claims: ClaimRecord[], released: Registry["released"] = []) => ({ tip, state: { claims, released, baseline: "b0", policy, stampKey: key.publicKey } as Registry });
const claimA = { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a", since: "", active: "2026-10-05T10:00:00.000Z" };
const vote = (reviewer: string) => ({ commit: "h1", reviewer, role: "tests", verdict: "approve" as const, evidence: "ok", at: "" });

async function stampedMerge(overrides: Partial<MergeRecord> = {}): Promise<MergeRecord> {
	const merge: MergeRecord = { commit: "m1", author: "agent-a", change: "a-1", claimsTip: "r1", votesTip: "v1", head: "h1", base: "p1", files: ["src/a/x.ts"], by: toolkit.by, ...overrides };
	return { ...merge, stamp: await toolkit.stamp(mergeStampPayload(merge)) };
}

describe("the audit, with stamps", () => {
	it("attributes a stamped merge to its verified identity and finds nothing wrong", async () => {
		const records = {
			registry: [registryAt("r1", [await stampedClaim(claimA)])],
			votes: [{ tip: "v1", state: { votes: [await stampedVote(vote("rev-1")), await stampedVote(vote("rev-2"))] } as Votes }],
			policy,
			merges: [await stampedMerge()],
		};
		expect(await audit(records)).toEqual([]);
	});

	it("reports a merge without a valid stamp: its agent and trailers can't be trusted", async () => {
		const records = {
			registry: [registryAt("r1", [await stampedClaim(claimA)])],
			votes: [{ tip: "v1", state: { votes: [await stampedVote(vote("rev-1")), await stampedVote(vote("rev-2"))] } as Votes }],
			policy,
			merges: [{ ...(await stampedMerge()), agent: undefined, author: "agent-b", stamp: "forged" } as MergeRecord],
		};
		expect(await audit(records)).toEqual([{ commit: "m1", author: "agent-b", rule: "unverified", detail: "the merge has no valid GitHive stamp: whoever made it, and what its trailers say, is unverified" }]);
	});

	it("doesn't count an unstamped vote, and reports it", async () => {
		const forged = { ...vote("rev-2"), by: "service:agent-a" } as VoteRecord;
		const records = {
			registry: [registryAt("r1", [await stampedClaim(claimA)])],
			votes: [{ tip: "v1", state: { votes: [await stampedVote(vote("rev-1")), forged] } as Votes }],
			policy,
			merges: [await stampedMerge()],
		};
		expect(await audit(records)).toEqual([
			{ commit: "v1", author: "rev-2", rule: "unverified-record", detail: "rev-2's vote on h1 has no valid GitHive stamp, so it doesn't count" },
			{ commit: "m1", author: "agent-a", rule: "unapproved", detail: "h1 had 1 of 2 approvals at v1", by: "service:agent-a" },
		]);
	});

	it("reports a claim that vanished without a stamped release", async () => {
		const records = {
			registry: [registryAt("r1", [await stampedClaim(claimA)]), registryAt("r2", [])],
			merges: [],
		};
		expect(await audit(records)).toEqual([{ commit: "r2", author: "agent-a", rule: "unverified-record", detail: "a-1's claim was removed at r2 without a stamped release" }]);
	});

	it("reports a claim added without a stamp", async () => {
		const records = { registry: [registryAt("r1", [claimA])], merges: [] };
		expect(await audit(records)).toEqual([{ commit: "r1", author: "agent-a", rule: "unverified-record", detail: "a-1's claim has no valid GitHive stamp" }]);
	});

	it("reports a stamped revert of a commit the audit doesn't report", async () => {
		const revert: MergeRecord = { commit: "x1", author: "agent-a", reverts: "m1", base: "m1", files: ["src/a/x.ts"], by: toolkit.by };
		const records = {
			registry: [registryAt("r1", [await stampedClaim(claimA)])],
			votes: [{ tip: "v1", state: { votes: [await stampedVote(vote("rev-1")), await stampedVote(vote("rev-2"))] } as Votes }],
			policy,
			merges: [await stampedMerge(), { ...revert, stamp: await toolkit.stamp(revertStampPayload(revert)) }],
		};
		expect(await audit(records)).toEqual([{ commit: "x1", author: "agent-a", rule: "unjustified-revert", detail: "reverted m1, which the audit doesn't report", by: "service:agent-a" }]);
	});
});
