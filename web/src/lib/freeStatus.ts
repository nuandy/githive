import type { FreeSnapshot } from "../api";
import type { ChangeStatus } from "./changeStatus";
import { identityName } from "./agent";

// Coordinator-free repos keep no change records: a change is a claim in force,
// with its pushed head, the approvals on that head, and any hosted agents on it.

export type FreeClaim = FreeSnapshot["claims"][number];
export type FreeVote = FreeSnapshot["votes"][number];

export function freeClaimStatus(claim: FreeClaim): ChangeStatus {
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
