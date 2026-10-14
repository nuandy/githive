import { projectBranch } from "../../project-branch";
import { GitCasLog } from "../../record-log";
import { onActions } from "../actions-checks";
import { settingsForBranch } from "../branch-rules";
import { presentClaim } from "../branch-scope";
import { type ClaimStore, claimStore } from "../claim-store";
import { type ClaimRecord, type Registry, shardClaims, shardingReason } from "../claims";
import { trustedClaim } from "../github-settings";
import { BUILDING_IDLE_MS } from "../staleness";
import { VOTE_BUCKETS, type VoteStore, voteStore } from "../vote-store";
import { type ReviewPolicy, shardVotes, type Votes, votesShardingReason } from "../votes";
import type { ClaimsAdvice, ToolContext } from "./context";

// A repo's records as the tools read them: the claims registry, votes and backlog logs, sharded
// stores, and the settings that apply to a branch.

/** No reviews by default, as on GitHub: a claimed, pushed change merges as is. A repo opts in through settings. */
export const DEFAULT_POLICY: ReviewPolicy = { required: 0, vetoes: [] };

export const HOSTED_PREFIX = "githive-";

export const DEFAULT_SHARD_DEPTH = 2;

/** Records repos per sharded repo. Artifacts takes one push at a time per repo, so shards are spread out. */
export const DEFAULT_RECORDS_REPOS = 16;
export const MOST_RECORDS_REPOS = 64;

/** No claim goes stale sooner than this after its agent last claimed (see staleness.ts). */
export const STALE_AFTER_MS = BUILDING_IDLE_MS;

/** The most reviews or backlog items a call lists; the rest are only counted. */
export const LISTED_AT_MOST = 40;

/** The most agents register, or work items add_work takes, in one call. */
export const MOST_AT_ONCE = 500;

export const claimsRef = (repo: string) => `refs/notes/githive-claims/${repo}`;

export const votesRef = (repo: string) => `refs/notes/githive-votes/${repo}`;

/** The checks a repo runs in containers: none when they run on GitHub Actions. */
export const containerChecks = (verify: string[] | undefined) => (onActions(verify) ? [] : (verify ?? []));

export const workRef = (repo: string) => `refs/notes/githive-work/${repo}`;

/** A record's log: the context's shared one, or one for this call. */
export function recordLog<S>(ctx: ToolContext, repo: string, ref: string): GitCasLog<S> {
	return ctx.records ? ctx.records<S>(repo, ref) : new GitCasLog<S>(() => ctx.remote(repo, "write"), repo, ref);
}

/** Reads the claims advice fresh from the records (see keptClaims). */
export async function advice(ctx: ToolContext, repo: string): Promise<ClaimsAdvice> {
	const log = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const head = await log.read();
	const view = await storeFor(ctx, repo, head?.commit.state, { log, head }).read();
	const branch = projectBranch(head?.commit.state);
	return {
		claims: view.claims.map((c) => presentClaim(c, branch)),
		merged: view.released.filter((r) => r.mergedAs).map((r) => r.change),
	};
}

/** A branch's review policy and checks: the repo's, overridden by any matching branch rule (see branch-rules.ts). */
export function branchSettings(registry: Registry | null | undefined, branch: string | undefined) {
	const project = projectBranch(registry);
	return settingsForBranch(
		{
			policy: registry?.policy ?? DEFAULT_POLICY,
			verify: registry?.verify ?? [],
			...(registry?.branchRules ? { rules: registry.branchRules } : {}),
			project,
		},
		branch ?? project,
	);
}

/** What GitHub's changes are held to while the repo trusts them: no review. Their checks still run. */
export const TRUSTED_POLICY: ReviewPolicy = { required: 0, vetoes: [] };

/** The policy a change is held to: its branch's, or none for GitHub's change while the repo trusts it. */
export function claimPolicy(
	registry: Registry | null | undefined,
	claim: Pick<ClaimRecord, "agent" | "source" | "into">,
): ReviewPolicy {
	return trustedClaim(registry, claim) ? TRUSTED_POLICY : branchSettings(registry, claim.into).policy;
}

/** How a repo's claims are kept, for callers and the dashboard. */
export function shardingOf(registry: Registry | null | undefined) {
	return {
		shardDepth: registry?.shardDepth ?? 0,
		recordsRepos: registry?.recordsRepos ?? 0,
		sharding: claimsSharding(registry),
	};
}

function claimsSharding(registry: Registry | null | undefined) {
	if (registry?.shardDepth) return { since: registry.shardedAt, because: registry.shardedBecause };
	return registry?.autoShard ? "on demand" : "never";
}

/** Shards the claims if the load calls for it (see shardingReason). Returns the new registry, or null. */
export async function shardIfBusy(
	ctx: ToolContext,
	repo: string,
	log: GitCasLog<Registry>,
	registry: Registry | null | undefined,
	agent: string,
) {
	const reason = shardingReason(registry, agent);
	if (!reason || !registry?.autoShard) return null;
	const { depth, recordsRepos } = registry.autoShard;
	const spread = recordsRepos && ctx.recordsRemote && ctx.createRecordsRepos ? recordsRepos : 0;
	if (spread) await ctx.createRecordsRepos!(repo, spread);
	const outcome = await shardClaims(log, { depth, recordsRepos: spread, reason });
	if (outcome.ok) console.log(`sharding ${repo}'s claims: ${reason}`);
	return (await log.read())?.commit.state ?? null;
}

/** A repo's votes: in its votes record, and in buckets by commit once sharded (see vote-store.ts). */
export function votesFor(
	ctx: ToolContext,
	repo: string,
	rootHead?: Awaited<ReturnType<GitCasLog<Votes>["read"]>>,
): VoteStore {
	return voteStore({
		repo,
		root: recordLog<Votes>(ctx, repo, votesRef(repo)),
		...(rootHead !== undefined ? { rootHead } : {}),
		remote: () => ctx.remote(repo, "write"),
		...(ctx.recordsRemote ? { recordsRemote: (index: number) => ctx.recordsRemote!(repo, index, "write") } : {}),
	});
}

/**
 * Shards the repo's votes if the load calls for it (see votesShardingReason), where its claims may shard.
 * Returns the votes record's head for the vote that follows, or undefined if it wasn't read.
 */
export async function shardVotesIfBusy(
	ctx: ToolContext,
	repo: string,
	registry: Registry | null | undefined,
	reviewer: string,
) {
	if (!registry?.autoShard && !registry?.shardDepth) return undefined;
	const log = recordLog<Votes>(ctx, repo, votesRef(repo));
	const head = await log.read();
	const reason = votesShardingReason(head?.commit.state, reviewer);
	if (!reason) return head;
	const wanted = registry.autoShard?.recordsRepos ?? registry.recordsRepos ?? 0;
	const spread = wanted && ctx.recordsRemote && ctx.createRecordsRepos ? wanted : 0;
	if (spread) await ctx.createRecordsRepos!(repo, spread);
	const outcome = await shardVotes(log, { buckets: VOTE_BUCKETS, recordsRepos: spread, reason });
	if (outcome.ok) console.log(`sharding ${repo}'s votes: ${reason}`);
	return log.read();
}

export function storeFor(
	ctx: ToolContext,
	repo: string,
	registry: Registry | null | undefined,
	root?: { log: GitCasLog<Registry>; head: Awaited<ReturnType<GitCasLog<Registry>["read"]>> },
): ClaimStore {
	return claimStore({
		repo,
		registry,
		root: root?.log ?? recordLog<Registry>(ctx, repo, claimsRef(repo)),
		...(root ? { rootHead: root.head } : {}),
		...(ctx.recordsRemote ? { recordsRemote: (index: number) => ctx.recordsRemote!(repo, index, "write") } : {}),
		remote: () => ctx.remote(repo, "write"),
		log: ctx.records ? (ref) => ctx.records!<Registry>(repo, ref) : undefined,
		...(ctx.forgetAttempts ? { forgetAttempts: (change: string) => ctx.forgetAttempts!(repo, change) } : {}),
	});
}

/** The roles GitHive's own reviewers take on a change: one general review, and every role that can veto. */
export const hostedRoles = (vetoes: string[]) => [...new Set(["review", ...vetoes])];
