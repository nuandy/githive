import type { RepoSnapshot } from "../api";
import type { ChangeStatus } from "./changeStatus";
import { identityName } from "./agent";

// Repos keep no change records. A change is a claim in force, with its pushed head,
// the approvals on that head, and any hosted agents on it.

export type Claim = RepoSnapshot["claims"][number];
export type Vote = RepoSnapshot["votes"][number];

export function claimStatus(claim: Claim): ChangeStatus {
	if (claim.attention)
		return {
			kind: "needs-you",
			label: "Needs you",
			tone: "needs",
			description: `${claim.attention.agent} asks you: ${claim.attention.reason}`,
		};
	const builder = claim.hosted?.builder;
	if (builder?.status === "failed")
		return {
			kind: "needs-you",
			label: "Needs you",
			tone: "needs",
			description: builder.error ? `The builder failed: ${builder.error}` : "The builder failed.",
		};
	if (claim.approval.vetoedBy.length)
		return {
			kind: "changes-requested",
			label: "Changes requested",
			tone: "bad",
			description: `Blocked by ${claim.approval.vetoedBy.join(", ")}.`,
		};
	if (claim.approval.approved)
		return {
			kind: "approved",
			label: "Approved",
			tone: "good",
			description: "Approved; it merges once its checks pass.",
		};
	if (!claim.head) return { kind: "draft", label: "Draft", tone: "neutral", description: "Nothing pushed yet." };
	if (claim.hosted?.reviewers.some((reviewer) => reviewer.verdict === "reject"))
		return {
			kind: "changes-requested",
			label: "Changes requested",
			tone: "bad",
			description: "A reviewer asked for changes.",
		};
	const awaiting = awaitingVetoes(claim);
	if (claim.approval.approvals >= claim.approval.required && awaiting.length)
		return {
			kind: "in-review",
			label: "In review",
			tone: "warn",
			description: `Waiting for ${awaiting.join(", ")}, which can block it.`,
		};
	return { kind: "in-review", label: "In review", tone: "warn", description: "Waiting for approvals." };
}

/** Roles that can block the change and haven't approved yet (older servers don't say). */
export function awaitingVetoes(claim: Claim): string[] {
	return Array.isArray(claim.approval.awaiting) ? claim.approval.awaiting : [];
}

/** "1/2 approvals", "Waiting for security", "Blocked by security": the review badge. */
export function claimApprovalLabel(claim: Claim): string {
	const { approval } = claim;
	if (approval.vetoedBy.length) return `Blocked by ${approval.vetoedBy.join(", ")}`;
	const awaiting = awaitingVetoes(claim);
	if (!approval.approved && approval.approvals >= approval.required && awaiting.length)
		return `Waiting for ${awaiting.join(", ")}`;
	return `${approval.approvals}/${approval.required} approvals`;
}

/** The claim's title: the first line of what the agent set out to do, or its id. */
export function claimTitle(claim: Claim): string {
	const first = (claim.intent ?? "").split("\n")[0].trim();
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
