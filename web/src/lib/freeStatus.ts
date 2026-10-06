import type { FreeSnapshot } from "../api";
import type { ChangeStatus } from "./changeStatus";
import { identityName } from "./agent";

// Coordinator-free repos keep no change records: a change is a claim in force,
// with its pushed head, the approvals on that head, and any hosted agents on it.

export type FreeClaim = FreeSnapshot["claims"][number];
export type FreeVote = FreeSnapshot["votes"][number];

export function freeClaimStatus(claim: FreeClaim): ChangeStatus {
	if (claim.attention) return { kind: "needs-you", label: "Needs you", tone: "needs", description: `${claim.attention.agent} asks you: ${claim.attention.reason}` };
	const builder = claim.hosted?.builder;
	if (builder?.status === "failed")
		return { kind: "needs-you", label: "Needs you", tone: "needs", description: builder.error ? `The builder failed: ${builder.error}` : "The builder failed." };
	if (claim.approval.vetoedBy.length)
		return { kind: "changes-requested", label: "Changes requested", tone: "bad", description: `Blocked by ${claim.approval.vetoedBy.join(", ")}.` };
	if (claim.approval.approved) return { kind: "approved", label: "Approved", tone: "good", description: "Approved; it merges once its checks pass." };
	if (!claim.head) return { kind: "draft", label: "Draft", tone: "neutral", description: "Nothing pushed yet." };
	if (claim.hosted?.reviewers.some((r) => r.verdict === "reject"))
		return { kind: "changes-requested", label: "Changes requested", tone: "bad", description: "A reviewer asked for changes." };
	const awaiting = awaitingVetoes(claim);
	if (claim.approval.approvals >= claim.approval.required && awaiting.length)
		return { kind: "in-review", label: "In review", tone: "warn", description: `Waiting for ${awaiting.join(", ")}, which can block it.` };
	return { kind: "in-review", label: "In review", tone: "warn", description: "Waiting for approvals." };
}

/** Roles that can block the change and haven't approved yet (older servers don't say). */
export function awaitingVetoes(claim: FreeClaim): string[] {
	return Array.isArray(claim.approval.awaiting) ? claim.approval.awaiting : [];
}

/** "1/2 approvals", "Waiting for security", "Blocked by security", like the elected repos' review badge. */
export function claimApprovalLabel(claim: FreeClaim): string {
	const { approval } = claim;
	if (approval.vetoedBy.length) return `Blocked by ${approval.vetoedBy.join(", ")}`;
	const awaiting = awaitingVetoes(claim);
	if (!approval.approved && approval.approvals >= approval.required && awaiting.length) return `Waiting for ${awaiting.join(", ")}`;
	return `${approval.approvals}/${approval.required} approvals`;
}

/** The claim's title: the first line of what the agent set out to do, or its id. */
export function claimTitle(claim: FreeClaim): string {
	const first = (claim.intent ?? "").split("\n")[0].trim();
	return first || claim.change;
}

export function claimAgent(claim: FreeClaim): string {
	return claim.agent || identityName(claim.by) || "agent";
}

/** Votes on the claim's current head, newest per reviewer last. */
export function votesForClaim(claim: FreeClaim, votes: FreeVote[]): FreeVote[] {
	const head = claim.head;
	if (!head) return [];
	return votes.filter((vote) => !!vote.commit && (vote.commit.startsWith(head) || head.startsWith(vote.commit)));
}

/**
 * How a repo keeps its claims, as a short label and a sentence: in one record
 * (the cheapest while few agents write), or sharded by path once the load
 * called for it. Null for older servers, which don't say.
 */
export function shardingSummary(snapshot: Pick<FreeSnapshot, "sharding" | "shardDepth">): { label: string; sharded: boolean; detail: string } | null {
	const { sharding } = snapshot;
	if (!sharding) return null;
	if (sharding === "on demand")
		return {
			label: "One claims record",
			sharded: false,
			detail: "Claims are kept in one record, the fastest while few agents write. They are sharded by path automatically once 8 agents hold claims, or claims are written more than 15 times a minute.",
		};
	if (sharding === "never") return { label: "One claims record", sharded: false, detail: "Claims are kept in one record; this repo was set never to shard them." };
	const deep = snapshot.shardDepth ? `, ${snapshot.shardDepth} ${snapshot.shardDepth === 1 ? "folder" : "folders"} deep` : "";
	const since = sharding.since ? ` since ${new Date(sharding.since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";
	const because = sharding.because ? ` (${sharding.because})` : "";
	return {
		label: "Sharded claims",
		sharded: true,
		detail: `Claims are sharded by path${deep}${since}${because}, so agents in different parts of the tree never wait on each other. Claims made before stay in the top record, above every shard.`,
	};
}

/** How a repo keeps its votes, as a sentence: in one record, or in buckets by commit once the load called for it. Null for older servers. */
export function votesShardingSummary(snapshot: Pick<FreeSnapshot, "votesSharding">): { sharded: boolean; detail: string } | null {
	const { votesSharding } = snapshot;
	if (!votesSharding) return null;
	if (votesSharding === "on demand")
		return { sharded: false, detail: "Votes are kept in one record. They are split by commit automatically once 8 reviewers vote within 5 minutes, or votes come more than 15 times a minute." };
	if (votesSharding === "never") return { sharded: false, detail: "Votes are kept in one record; this repo was set never to split them." };
	const since = votesSharding.since ? ` since ${new Date(votesSharding.since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";
	const because = votesSharding.because ? ` (${votesSharding.because})` : "";
	return { sharded: true, detail: `Votes are split by commit${since}${because}, so reviewers of different changes never wait on each other. Votes cast before stay in the top record.` };
}

/** The header's badge: what's sharded (claims, votes, both), or one claims record; the detail says both. Null for older servers. */
export function recordsBadge(snapshot: Pick<FreeSnapshot, "sharding" | "shardDepth" | "votesSharding">): { label: string; sharded: boolean; detail: string } | null {
	const claims = shardingSummary(snapshot);
	const votes = votesShardingSummary(snapshot);
	if (!claims) return null;
	const label = claims.sharded && votes?.sharded ? "Sharded claims & votes" : claims.sharded ? "Sharded claims" : votes?.sharded ? "Sharded votes" : claims.label;
	return { label, sharded: claims.sharded || !!votes?.sharded, detail: [claims.detail, votes?.detail].filter(Boolean).join(" ") };
}
