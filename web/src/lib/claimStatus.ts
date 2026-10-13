import type { RepoSnapshot } from "../api";
import type { ChangeStatus } from "./changeStatus";
import { displayName, identityName } from "./agent";
import { listed } from "./decision";
import {
	type ChangeState,
	changeState,
	rejectionsOnHead,
	type RepoPolicy,
	type StateContext,
	STATES,
	waitingOn,
} from "./status";

// Repos keep no change records. A change is a claim in force, with its pushed head,
// the approvals on that head, and any hosted agents on it.

export type Claim = RepoSnapshot["claims"][number];
export type Vote = RepoSnapshot["votes"][number];

/**
 * How a change stands, from its claim, the votes cast and what else status.ts reads (who may vote as each role, the
 * batch being checked, the time): its state's noun and tone, and a sentence on what is happening and who acts next.
 */
export function claimStatus(claim: Claim, votes: Vote[] = [], context: Omit<StateContext, "votes"> = {}): ChangeStatus {
	const kind = changeState(claim, { ...context, votes });
	const { label, tone } = STATES[kind];
	return { kind, label, tone, description: describeState(kind, claim, votes, context.settings) };
}

function describeState(state: ChangeState, claim: Claim, votes: Vote[], settings?: RepoPolicy): string {
	switch (state) {
		case "needs-person": {
			const waiting = waitingOn(claim, { votes, settings });
			if (waiting?.kind === "vote") return `Waiting for a ${waiting.role} vote, which only a person can give.`;
			if (!waiting || waiting.agent.startsWith("githive-")) return waiting?.reason ?? "It waits on a person.";
			return `${waiting.agent} asks a person: ${waiting.reason}`;
		}
		case "changes-requested":
			return claim.approval.vetoedBy.length
				? `Blocked by ${claim.approval.vetoedBy.join(", ")}.`
				: "A reviewer asked for changes.";
		case "checks-failed":
			return "Its checks failed on this commit; its agent fixes it and pushes again.";
		case "approved":
			return claim.trusted
				? "GitHub's changes, trusted: it lands through the checks without review."
				: "Approved; it lands once its checks pass.";
		case "landing": {
			// The batch being checked lands it all the same: a veto cast meanwhile says so, and stops the next one.
			const asked = askedForChanges(claim, votes);
			return asked.length
				? `Being checked to land; ${listed(asked)} asked for changes meanwhile.`
				: "Being checked to land, with the next batch.";
		}
		case "building":
			return "Nothing pushed yet.";
		case "abandoned":
			return "Its agent has gone quiet on its turn: another agent may take it.";
		case "in-review": {
			const awaiting = awaitingVetoes(claim);
			if (claim.approval.approvals >= claim.approval.required && awaiting.length)
				return `Waiting for ${awaiting.join(", ")}, which can block it.`;
			return "Waiting for approvals.";
		}
		case "landed":
			return "Landed.";
		case "released":
			return "Its claim was released.";
	}
}

export { rejectionsOnHead } from "./status";

/**
 * Who asked for changes on the change's head, by role ("a reviewer" for review): its rejections, or, where the votes
 * read don't show them, who vetoed it. Failed checks are the batch's to decide again.
 */
function askedForChanges(claim: Claim, votes: Vote[]): string[] {
	const roles = rejectionsOnHead(claim, votes)
		.map((vote) => vote.role)
		.filter((role) => role !== "checks");
	if (!roles.length) return claim.approval.vetoedBy.map((who) => displayName(who) ?? who);
	return [...new Set(roles)].map((role) => (role === "review" ? "a reviewer" : role));
}

/** Roles that can block the change and haven't approved yet (older servers don't say). */
export function awaitingVetoes(claim: Claim): string[] {
	return Array.isArray(claim.approval.awaiting) ? claim.approval.awaiting : [];
}

/** Whether a change is GitHub's, brought back by GitHive's githive-github. */
export const isFromGitHub = (claim: { agent?: string; source?: string }) =>
	claim.agent === "githive-github" && !!claim.source?.startsWith("github/");

/** "1/2 approvals", "Waiting for security", "Blocked by security": the review badge. */
export function claimApprovalLabel(claim: Claim): string {
	const { approval } = claim;
	if (claim.trusted) return "No review: trusted";
	if (approval.vetoedBy.length) return `Blocked by ${approval.vetoedBy.join(", ")}`;
	const awaiting = awaitingVetoes(claim);
	if (!approval.approved && approval.approvals >= approval.required && awaiting.length)
		return `Waiting for ${awaiting.join(", ")}`;
	return `${approval.approvals}/${approval.required} approvals`;
}

/** The claim's title: the first line of what the agent set out to do, or its id. */
export function claimTitle(claim: Claim): string {
	const first = (claim.intent ?? "").split("\n")[0]?.trim();
	return first || claim.change;
}

export function claimAgent(claim: Claim): string {
	return claim.agent || identityName(claim.by) || "agent";
}

/** Votes on the claim's current head, newest per reviewer last. */
export function votesForClaim(claim: Claim, votes: Vote[]): Vote[] {
	const head = claim.head;
	if (!head) return [];
	return votes.filter((vote) => !!vote.commit && (vote.commit.startsWith(head) || head.startsWith(vote.commit)));
}

/**
 * How a repo keeps its claims, as a short label and a sentence: in one record
 * (the cheapest while few agents write), or sharded by path once the load
 * called for it. Null for older servers, which don't say.
 */
export function shardingSummary(
	snapshot: Pick<RepoSnapshot, "sharding" | "shardDepth">,
): { label: string; sharded: boolean; detail: string } | null {
	const { sharding } = snapshot;
	if (!sharding) return null;
	if (sharding === "on demand")
		return {
			label: "One claims record",
			sharded: false,
			detail:
				"Claims are kept in one record, the fastest while few agents write. They are sharded by " +
				"path automatically once 8 agents hold claims, or claims are written more than 15 times a " +
				"minute.",
		};
	if (sharding === "never")
		return {
			label: "One claims record",
			sharded: false,
			detail: "Claims are kept in one record; this repo was set never to shard them.",
		};
	const depth = snapshot.shardDepth;
	const folders = depth === 1 ? "folder" : "folders";
	const deep = depth ? `, ${depth} ${folders} deep` : "";
	const since = sharding.since ? ` since ${shardedAt(sharding.since)}` : "";
	const because = sharding.because ? ` (${sharding.because})` : "";
	return {
		label: "Sharded claims",
		sharded: true,
		detail:
			`Claims are sharded by path${deep}${since}${because}, so agents in different parts of the tree ` +
			"never wait on each other. Claims made before stay in the top record, above every shard.",
	};
}

const shardedAt = (since: string) =>
	new Date(since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * How a repo stores its votes, as a sentence: in one record, or in buckets by commit once the load called
 * for it. Null for older servers.
 */
export function votesShardingSummary(
	snapshot: Pick<RepoSnapshot, "votesSharding">,
): { sharded: boolean; detail: string } | null {
	const { votesSharding } = snapshot;
	if (!votesSharding) return null;
	if (votesSharding === "on demand")
		return {
			sharded: false,
			detail:
				"Votes are kept in one record. They are split by commit automatically once 8 reviewers " +
				"vote within 5 minutes, or votes come more than 15 times a minute.",
		};
	if (votesSharding === "never")
		return { sharded: false, detail: "Votes are kept in one record; this repo was set never to split them." };
	const since = votesSharding.since ? ` since ${shardedAt(votesSharding.since)}` : "";
	const because = votesSharding.because ? ` (${votesSharding.because})` : "";
	return {
		sharded: true,
		detail:
			`Votes are split by commit${since}${because}, so reviewers of different changes never wait on each ` +
			"other. Votes cast before stay in the top record.",
	};
}

/**
 * The header's badge: what's sharded (claims, votes or both), or one claims record. The detail covers both.
 * Null for older servers.
 */
export function recordsBadge(
	snapshot: Pick<RepoSnapshot, "sharding" | "shardDepth" | "votesSharding">,
): { label: string; sharded: boolean; detail: string } | null {
	const claims = shardingSummary(snapshot);
	const votes = votesShardingSummary(snapshot);
	if (!claims) return null;
	return {
		label: badgeLabel(claims, votes),
		sharded: claims.sharded || !!votes?.sharded,
		detail: [claims.detail, votes?.detail].filter(Boolean).join(" "),
	};
}

function badgeLabel(claims: { label: string; sharded: boolean }, votes: { sharded: boolean } | null): string {
	if (claims.sharded && votes?.sharded) return "Sharded claims & votes";
	if (claims.sharded) return "Sharded claims";
	if (votes?.sharded) return "Sharded votes";
	return claims.label;
}

/** Who may vote as each blocking role, in words: the policy's grants, else people and GitHive's reviewers. */
export function blockingRoles(policy: RepoSnapshot["policy"]): { role: string; holders: string }[] {
	const ruleVetoes = (policy.escalate ?? []).flatMap((rule) => rule.vetoes ?? []);
	const roles = [...new Set([...policy.vetoes, ...ruleVetoes])];
	return roles.map((role) => ({
		role,
		holders: (policy.grants?.[role] ?? ["person:*", "githive"]).map(grantName).join(", "),
	}));
}

/** A grant in words: people, GitHive's reviewers, every agent under an owner, or one name. */
function grantName(grant: string) {
	if (grant === "person:*") return "people";
	if (grant === "githive") return "GitHive's reviewers";
	const readable = (identity: string) => (identity.startsWith("person:") ? identityName(identity) : identity);
	if (grant.endsWith("/*")) return `any agent under ${readable(grant.slice(0, -2))}`;
	return readable(grant);
}
