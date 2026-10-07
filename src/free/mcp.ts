import git from "isomorphic-git";
import { GitCasLog } from "../election-git";
import { fail, requiredPaths, requiredString } from "../errors";
import { branchHead, type Remote, Workspace } from "../git";
import { projectBranch } from "../project-branch";
import { Timing } from "../timing";
import { annotate, destroys, reads, writes } from "../tool-annotations";
import { changeId, normalizeClaim } from "../open-mode";
import { audit } from "./audit";
import { checkChange } from "./check";
import { claimStore, type ClaimStore } from "./claim-store";
import { registerAgent, shardClaims, shardingReason, startFree, type ClaimRecord, type Registry } from "./claims";
import { readMainMerges, readRecordHistory, readRefHistories, readShardHistories } from "./git-records";
import { type CheckRunner, mergeChange } from "./merge";
import { revertViolation } from "./revert";
import type { Stamper } from "./stamp";
import { approval, countedVotes, effectiveFreePolicy, openFlag, shardVotes, votesShardingReason, type ReviewPolicy, type VoteRecord, type Votes } from "./votes";
import { VOTE_BUCKETS, type VoteStore, voteStore, votesPrefix } from "./vote-store";
import { addWork, nextFor, type Work, workId } from "./work";
import { SENSITIVE_PATHS } from "../types";

// The coordinator-free MCP tools (see docs/coordinator-free.md). Stateless: each
// tool reads or writes the repo's records in Git and reports what Git said.
// Nothing here decides for anyone; an agent can do the same with plain git,
// and the audit reads the same records either way.

export interface FreeContext {
	/** Credentials for a project repo. */
	remote: (repo: string, scope: "read" | "write") => Promise<Remote>;
	/** A record's log (claims, votes), kept across calls so an unmoved ref isn't fetched again; without it, each call makes its own. */
	records?: <S>(repo: string, ref: string) => GitCasLog<S>;
	/** Credentials for one of a repo's records repos, which hold its claim shards when they're spread out. */
	recordsRemote?: (repo: string, k: number, scope: "read" | "write") => Promise<Remote>;
	/** Creates a repo's records repos (harmless if they exist). */
	createRecordsRepos?: (repo: string, count: number) => Promise<void>;
	/** Credentials for an agent's own fork of a project repo, where its changes' branches live; asking to write creates the fork. */
	changeRemote?: (repo: string, agent: string, scope: "read" | "write") => Promise<Remote>;
	/** Read access to a change's own fork, where changes made before forks were per agent keep their branch. */
	legacyChangeRemote?: (repo: string, change: string) => Promise<Remote>;
	/** A branch's head in a project repo. */
	head: (repo: string, branch: string) => Promise<string>;
	/** A project repo's default branch, where its HEAD points (main, master, ...); without it, main. */
	defaultBranch?: (repo: string) => Promise<string>;
	/** Runs a repo's checks on its branch plus a change (live, the Gate's container). */
	runChecks?: (repo: string) => CheckRunner;
	/** Stamps what this caller writes with their verified identity (Blueprint's key), and the agent name their key is for; without it, nothing is stamped. */
	stamper?: (agent?: string) => Promise<Stamper | undefined>;
	/** The caller's agent key (free_register), from the X-Blueprint-Agent-Key header. */
	agentKey?: string;
	/** Blueprint's own hosted agents, who act under the reserved blueprint- names. */
	hosted?: boolean;
	/** Notes a repo in coordinator-free mode, so the dashboard can list it. */
	register?: (repo: string) => Promise<void>;
	/** Starts Blueprint's hosted reviewers on a change's current commit; each votes with free_vote (and, asked to, then tries to merge it). */
	requestReview?: (input: { repo: string; change: string; roles: string[]; summary?: string; mergeWhenApproved?: boolean }) => Promise<{ head: string; reviewers: string[] }>;
	/** What Blueprint's hosted agents on a change are doing: its builder, and the reviewers of its head. */
	agentStatus?: (repo: string, change: string, head: string | null, roles: string[]) => Promise<HostedStatus>;
	/** Times a request's steps, for its Server-Timing header. */
	timing?: Timing;
	/** Tells the dashboard's open pages that the repo's records changed. */
	ping?: (repo: string) => Promise<void>;
	/** Updates the repo's summary for the dashboard's list of repos (a hint; Git is what counts). */
	summarize?: (repo: string, patch: { open?: number; needsYou?: number; waiting?: { change: string; title: string; reason: string }[]; merged?: number; mergedBy?: number; violations?: number; lastActivity?: string; countedAt?: string }) => Promise<void>;
	/** Starts Blueprint's hosted builder on a claimed change. */
	startBuilder?: (input: { repo: string; change: string }) => Promise<{ change: string; builder: string }>;
}

export interface HostedStatus {
	builder?: { status: string; revisions: number; error?: string };
	reviewers: { role: string; status: string; verdict?: string }[];
}

/** One approval by default; a change to dependency, CI or deploy files also needs security's, who can veto it. */
export const DEFAULT_POLICY: ReviewPolicy = { required: 1, vetoes: [], escalate: [{ paths: SENSITIVE_PATHS, required: 2, vetoes: ["security"] }] };
const HOSTED_PREFIX = "blueprint-";
const DEFAULT_SHARD_DEPTH = 2;
/** Records repos per sharded repo, where they're available: Artifacts takes one push at a time per repo. */
const DEFAULT_RECORDS_REPOS = 8;
const STALE_AFTER_MS = 30 * 60_000;
const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
const votesRef = (repo: string) => `refs/notes/blueprint-votes/${repo}`;
const workRef = (repo: string) => `refs/notes/blueprint-work/${repo}`;

export const FREE_INSTRUCTIONS = `Coordinator-free mode (the free_* tools): nobody enforces the rules; every agent follows them, and an audit anyone can run shows who didn't.
Not sure what to do? free_next tells you the most useful thing for you now: merge or revise your own change, review someone else's, or build a piece of the backlog (free_add_work adds to it). Do it, then ask again.
Conventions:
1. free_claim the paths you will change before editing; edit only inside your claim. A refusal names who holds what: narrow your claim, or ask them.
2. Work on a branch changes/<change>, started from the project's branch, and push it to your own fork (free_credentials with your change: one fork per agent, for all its changes; only you can write it). The project's branch (free_start names it: main, master, ...) is written only through the toolkit.
3. Reviewers get the change's code with free_review_access (read-only: its branch in the author's fork, and the project to diff against), then free_vote on the exact commit they reviewed. A change merges with the policy's approvals, including every veto role's, and no veto; a veto role counts only from whoever free_start granted it (by default people and Blueprint's reviewers), so register with your key to vote as one. Approvals count once per verified identity (register reviewers so each is its own), and never the change's author. free_status shows your change's votes, with the evidence for any rejection to fix, and what's still needed.
4. Run free_check after you push: it test-merges your change with the project's branch and lists files outside your claim, so you hear about problems before merging.
5. free_merge merges your branch with trailers recording the claims and votes it checked, then releases your claim. Merge by hand only with the same trailers.
6. Claiming again (same paths) keeps your claim active. A claim idle for 30 minutes is released by whoever claims its paths, or by anyone (free_release with stale: true).
7. Anyone may free_revert a commit free_audit reports; the audit then counts it resolved.
8. Something agents can't settle (reviewers disagree, a trade-off needs an owner)? free_ask_human with the reason: a person sees it in their inbox and decides with their own vote.
9. free_request_review asks Blueprint's hosted reviewers for votes on your change; free_build has Blueprint's hosted builder make a change from start to merge.
10. Agents that share an Access identity tell themselves apart with free_register: it returns your agent key once; send it (header X-Blueprint-Agent-Key, or agent_key) with every call, and what you write is attributed to you. A registered name is never used without its key.
free_audit replays the records and lists every broken convention, with the commit and the agent.`;

const str = { type: "string" } as const;
const TOOL_LIST = [
	{ name: "free_start", description: "Start coordinator-free mode on a project repo (harmless if started): the review policy, the checks run before each merge (each change lives in its own fork, and only the toolkit writes the project), grants: who may vote as each role that can block a merge (registered agent names, 'person:*', a verified identity like 'person:<who>' or 'service:<id>', 'blueprint' for Blueprint's reviewers; unlisted roles: people and Blueprint's reviewers), how claims are kept: in one record until the load calls for more (8 agents holding claims, or over 15 claim writes a minute), then sharded per path 2 segments deep over 8 records repos, so agents in different parts of the tree never contend. shard_depth shards now, this deep (0: never), and records_repos is how many repos the shards are spread over, since a repo takes one push at a time. Returns them.", inputSchema: { type: "object", properties: { repo: str, required: { type: "number" }, vetoes: { type: "array", items: str }, escalate: { type: "array", items: { type: "object", properties: { paths: { type: "array", items: str }, required: { type: "number" }, vetoes: { type: "array", items: str } }, required: ["paths"] } }, grants: { type: "object", additionalProperties: { type: "array", items: str } }, verify: { type: "array", items: str }, shard_depth: { type: "number" }, records_repos: { type: "number" } }, required: ["repo"] } },
	{ name: "free_credentials", description: "Git access. With your change: a write token for its own fork, where its branch changes/<change> lives. Without: read access to the project repo.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo"] } },
	{ name: "free_claims", description: "The claims in force: who holds which paths, and why.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_claim", description: "Claim paths for your change (again to extend it, or to keep it active). Refused, naming the holder, if another claim overlaps; a claim in the way idle for 30 minutes is released as stale instead.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, paths: { type: "array", items: str }, intent: str }, required: ["repo", "change", "agent", "paths", "intent"] } },
	{ name: "free_release", description: "Release a claim: yours, or another's idle for 30 minutes with stale: true.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } }, required: ["repo", "change", "agent"] } },
	{ name: "free_next", description: "What you should do next, for any agent without a set role: merge your change if it's approved, revise it if a reviewer asked for changes, finish it if nothing is pushed; else review a change that's waiting (never your own, and a role that can block only if you hold it); else build a piece of the backlog nobody has taken; else wait. Says how to do it.", inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] } },
	{ name: "free_add_work", description: "Add a piece of work to the repo's backlog, for free_next to hand to an agent: a title, what it should do (intent), and the paths it's likely to touch. Its id (from the title unless given) is the change name to claim it under.", inputSchema: { type: "object", properties: { repo: str, title: str, intent: str, paths: { type: "array", items: str }, id: str, agent: str }, required: ["repo", "title", "intent", "agent"] } },
	{ name: "free_review_access", description: "Read access to a change you'll review: a read-only token for the author's fork, the change's branch (changes/<change>) and its pushed head, and read access to the project to diff against. Anyone may review; each grant is logged.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "free_vote", description: "Record your review verdict on the exact commit you reviewed.", inputSchema: { type: "object", properties: { repo: str, commit: str, reviewer: str, role: str, verdict: { type: "string", enum: ["approve", "reject"] }, evidence: str }, required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"] } },
	{ name: "free_merge", description: "Merge changes/<change> into the project's branch if the conventions hold, recording what was checked, then release the claim.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str }, required: ["repo", "change", "agent"] } },
	{ name: "free_build", description: "Have Blueprint's hosted builder make a change: it claims the paths, builds on changes/<change>, asks the hosted reviewers when done, and the change merges once approved and checked.", inputSchema: { type: "object", properties: { repo: str, intent: str, paths: { type: "array", items: str } }, required: ["repo", "intent", "paths"] } },
	{ name: "free_request_review", description: "Ask Blueprint's hosted reviewer agents to review your change's current commit (by default a general review, and every role that can veto it); each votes with free_vote.", inputSchema: { type: "object", properties: { repo: str, change: str, roles: { type: "array", items: str }, summary: str }, required: ["repo", "change"] } },
	{ name: "free_audit", description: "Replay the records and list every broken convention, with the commit and the agent (and whether a revert has resolved it).", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_revert", description: "Revert a commit the audit reports: its files go back to how they were before it, in a commit naming what it reverts.", inputSchema: { type: "object", properties: { repo: str, commit: str, agent: str }, required: ["repo", "commit", "agent"] } },
	{ name: "free_status", description: "Where a change stands: its claim (or how it ended), its branch head, the votes on that head with their evidence, the approvals still needed, and what Blueprint's hosted agents on it are doing.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "free_check", description: "An early check on your change, any time before merging: whether it still merges cleanly into the project's branch, and any files outside your claim. (Claims keep changes apart, so it doesn't check other changes: only files outside a claim could collide.) Reports only.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "free_ask_human", description: "Ask a person to decide something about a change you can't settle among agents (reviewers disagree, a trade-off needs an owner). It waits in their inbox until a person votes on the change's commit.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str }, required: ["repo", "change", "agent", "reason"] } },
	{ name: "free_register", description: "Register your agent name and get its secret key (shown once), so what you write is attributed to you even if you share an Access identity. With your current key, rotates it.", inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] } },
];
// Every tool takes the caller's agent key, for clients that can't set the header.
export const FREE_TOOLS = annotate(
	TOOL_LIST.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, agent_key: { type: "string", description: "Your agent key from free_register, if you can't send the X-Blueprint-Agent-Key header" } } } })),
	{
		free_start: writes("Start coordinator-free mode", { idempotent: true }),
		free_credentials: writes("Get Git access", { idempotent: true }),
		free_claims: reads("List claims"),
		free_review_access: reads("Get read access to a change to review"),
		free_next: reads("What to do next"),
		free_add_work: writes("Add work to the backlog"),
		free_claim: writes("Claim paths", { idempotent: true }),
		free_release: destroys("Release a claim", { idempotent: true }),
		free_vote: writes("Vote on a commit", { idempotent: true }),
		free_merge: writes("Merge a change"),
		free_build: writes("Build a change with Blueprint's agent"),
		free_request_review: writes("Request review"),
		free_audit: reads("Audit the records"),
		free_revert: destroys("Revert a commit"),
		free_status: reads("Change status"),
		free_check: reads("Check a change"),
		free_register: destroys("Register an agent key"),
		free_ask_human: writes("Ask a person"),
	},
);

const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

/** The agent name a key is for, checked against the registry; keys are `<agent>.<secret>`. */
async function keyAgent(registry: Registry | undefined, key: string) {
	const agent = key.slice(0, Math.max(0, key.lastIndexOf(".")));
	const record = agent ? registry?.agents?.[agent] : undefined;
	if (!record || record.keyHash !== (await sha256(key))) throw new Error("[403] unknown agent key");
	return agent;
}

/** Refuses acting as `name`: another name than the caller's key is for, a registered name without its key, or a hosted agent's name. */
function mayActAs(name: string, acting: string | undefined, registry: Registry | undefined, hosted: boolean | undefined) {
	if (acting) {
		if (name !== acting) throw new Error(`[403] your agent key is ${acting}'s; it can't act as ${name}`);
		return;
	}
	if (hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) throw new Error("[403] blueprint- names are Blueprint's hosted agents'");
	// "person:…", "service:…" name verified identities, which an agent can't take on.
	if (name.includes(":")) throw new Error("[403] an agent's name can't contain \":\"");
	if (registry?.agents?.[name]) throw new Error(`[403] ${name} is registered: call with its agent key`);
}

export type Args = Record<string, unknown>;

/** A record's log: the context's shared one, or one for this call. */
function recordLog<S>(ctx: FreeContext, repo: string, ref: string): GitCasLog<S> {
	return ctx.records ? ctx.records<S>(repo, ref) : new GitCasLog<S>(() => ctx.remote(repo, "write"), repo, ref);
}

/** A repo's claims, where its registry says they are: in the registry itself, or split into per-path shards. */
/** Role grants as free_start takes them: each role to a list of agent names, "person:*", verified identities or "blueprint". */
function validGrants(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[400] grants maps each role to who may vote as it");
	const grants: Record<string, string[]> = {};
	for (const [role, who] of Object.entries(value)) {
		if (!Array.isArray(who) || !who.every((w) => typeof w === "string" && w.trim())) throw new Error(`[400] grants.${role} is a list: agent names, "person:*", "person:<who>", "service:<id>" or "blueprint"`);
		grants[role] = who.map((w) => w.trim());
	}
	return grants;
}

/** How a repo's claims are kept, for callers and the dashboard. */
function shardingOf(registry: Registry | null | undefined) {
	return {
		shardDepth: registry?.shardDepth ?? 0,
		recordsRepos: registry?.recordsRepos ?? 0,
		sharding: registry?.shardDepth ? { since: registry.shardedAt, because: registry.shardedBecause } : registry?.autoShard ? "on demand" : "never",
	};
}

/**
 * Shard the repo's claims if the load calls for it (see shardingReason):
 * makes the records repos, then records the switch in the registry. Returns
 * the registry as it is now, or null if it stays as it was.
 */
async function shardIfBusy(ctx: FreeContext, repo: string, log: GitCasLog<Registry>, registry: Registry | null | undefined, agent: string) {
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
export function votesFor(ctx: FreeContext, repo: string, rootHead?: Awaited<ReturnType<GitCasLog<Votes>["read"]>>): VoteStore {
	return voteStore({
		repo,
		root: recordLog<Votes>(ctx, repo, votesRef(repo)),
		...(rootHead !== undefined ? { rootHead } : {}),
		remote: () => ctx.remote(repo, "write"),
		...(ctx.recordsRemote ? { recordsRemote: (k: number) => ctx.recordsRemote!(repo, k, "write") } : {}),
	});
}

/**
 * Shard the repo's votes if the load calls for it (see votesShardingReason),
 * where its claims may shard (on demand, or sharded from the start): makes the
 * records repos, then records the switch in the votes record. Returns the
 * votes record's head as it is now, for the vote that follows (undefined: not read).
 */
async function shardVotesIfBusy(ctx: FreeContext, repo: string, registry: Registry | null | undefined, reviewer: string) {
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

export function storeFor(ctx: FreeContext, repo: string, registry: Registry | null | undefined, root?: { log: GitCasLog<Registry>; head: Awaited<ReturnType<GitCasLog<Registry>["read"]>> }): ClaimStore {
	return claimStore({
		repo,
		registry,
		root: root?.log ?? recordLog<Registry>(ctx, repo, claimsRef(repo)),
		...(root ? { rootHead: root.head } : {}),
		...(ctx.recordsRemote ? { recordsRemote: (k: number) => ctx.recordsRemote!(repo, k, "write") } : {}), remote: () => ctx.remote(repo, "write"), log: ctx.records ? (ref) => ctx.records!<Registry>(repo, ref) : undefined });
}

/**
 * Where a repo's change branches live: each in its agent's own fork (one per
 * agent, a branch changes/<change> per change). Reading a change made before
 * forks were per agent, its branch is in that change's own fork instead.
 */
function changeSourceFor(ctx: FreeContext, repo: string) {
	return async (agent: string, scope: "read" | "write", change?: string): Promise<Remote> => {
		if (!ctx.changeRemote) throw new Error("[501] change forks aren't available here");
		if (scope === "write" || !change || !ctx.legacyChangeRemote) return ctx.changeRemote(repo, agent, scope);
		const fork = await ctx.changeRemote(repo, agent, "read").catch(() => null);
		if (fork && (await branchHead(fork, `changes/${change}`).catch(() => null))) return fork;
		return (await ctx.legacyChangeRemote(repo, change).catch(() => null)) ?? fork ?? ctx.changeRemote(repo, agent, "read");
	};
}

/** Where a change stands: its branch head, the votes on that head, the approvals against the policy, and Blueprint's hosted agents on it. */
async function changeStatus(ctx: FreeContext, repo: string, registry: Registry | null | undefined, votesOn: (head: string) => Promise<VoteRecord[]>, change: string, author: ClaimRecord | undefined, agent = author?.agent) {
	// No fork (or no branch on it) means nothing pushed yet.
	const head = await Promise.resolve()
		.then(() => changeSourceFor(ctx, repo)(agent ?? fail(409, `${change} has no agent`), "read", change))
		.then((source) => branchHead(source, `changes/${change}`))
		.catch(() => null);
	// The policy for the paths it claims: stricter for dependency, CI and deploy files, say.
	const paths = author?.paths ?? [];
	const policy = registry?.policy ?? DEFAULT_POLICY;
	const { required, vetoes } = effectiveFreePolicy(policy, paths);
	const cast = head ? (await votesOn(head)).filter((v) => v.commit === head) : [];
	const outcome = head ? approval({ votes: await countedVotes(cast, registry?.stampKey) }, head, policy, author, paths) : { approved: false, approvals: 0, vetoedBy: [], awaiting: vetoes };
	const hosted = ctx.agentStatus ? await ctx.agentStatus(repo, change, head, hostedFreeRoles(vetoes)).catch(() => undefined) : undefined;
	return { head, votes: cast, approval: { ...outcome, required }, ...(hosted ? { hosted } : {}) };
}

/** Replay a repo's records from Git: how many commits on the project's branch since the mode started, and what broke which convention. */
async function runAudit(ctx: FreeContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const remote = await t.time("token", () => ctx.remote(repo, "read"));
	// The votes don't depend on the registry: read them meanwhile.
	const votesRead = t.time("votes", () => readRecordHistory<Votes>(remote, votesRef(repo)));
	votesRead.catch(() => undefined);
	const registry = await t.time("registry", () => readRecordHistory<Registry>(remote, claimsRef(repo)));
	const baseline = registry[0]?.state.baseline;
	if (!baseline) throw new Error(`[409] coordinator-free mode hasn't started on ${repo}`);
	const start = registry[0].state;
	// Sharded since the start, or since the load called for it: the latest state says.
	const latest = registry.at(-1)!.state;
	const [merges, shards, votesHistory] = await Promise.all([
		t.time("merges", () => readMainMerges(remote, baseline, projectBranch(start))),
		latest.shardDepth
			? t.time("shards", async () => readShardHistories(latest.recordsRepos && ctx.recordsRemote ? await Promise.all(Array.from({ length: latest.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read"))) : [remote], repo))
			: undefined,
		votesRead,
	]);
	// The votes' buckets, once they're sharded: where the latest state says.
	const votesNow = votesHistory.at(-1)?.state;
	const voteBuckets = votesNow?.buckets
		? await t.time("buckets", async () =>
				readRefHistories<Votes>(votesNow.recordsRepos && ctx.recordsRemote ? await Promise.all(Array.from({ length: votesNow.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read"))) : [remote], votesPrefix(repo)),
			)
		: undefined;
	const violations = await t.time("audit", () => audit({ registry, ...(shards ? { shards } : {}), votes: votesHistory, ...(voteBuckets ? { voteBuckets } : {}), policy: start.policy ?? DEFAULT_POLICY, verify: start.verify, merges }));
	return { merges: merges.length, violations };
}

/** The audit of a coordinator-free repo, for the dashboard: it replays every record, so it's read apart from the snapshot. */
/**
 * One change's history, for its page on the dashboard: its claim (or how it
 * ended), the commits on its branch (the last 50, newest first), every vote on
 * any of them, and the merge if it merged.
 */
export async function freeChangeHistory(ctx: FreeContext, repo: string, change: string) {
	const t = ctx.timing ?? new Timing();
	const registry = (await t.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit.state;
	if (!registry?.baseline) throw new Error(`[404] coordinator-free mode hasn't started on ${repo}`);
	const { claim, released } = await t.time("change", () => storeFor(ctx, repo, registry).readChange(change));
	if (!claim && !released.length) throw new Error(`[404] no change ${change} on ${repo}`);
	const branch = projectBranch(registry);
	const mergedAs = released.find((r) => r.mergedAs)?.mergedAs;
	const commits = await Promise.resolve()
		.then(() => t.time("fork", () => changeSourceFor(ctx, repo)(claim?.agent ?? released.at(-1)!.agent, "read", change)))
		.then(async (source) => {
			// Shallow: a change is a few commits on a recent project head; finding where it left deepens history if that's further back.
			const ws = await t.time("clone", () => Workspace.clone(source, `changes/${change}`, { depth: 8 }));
			const head = await ws.head();
			// The change's own commits: back to where it left the project's branch (as it was before the merge, if it merged).
			const projectHead = await t.time("project", async () => ws.fetch("project", await ctx.remote(repo, "read"), branch));
			const before = mergedAs ? (await ws.ensureCommit(mergedAs)).commit.parent[0] : projectHead;
			const stop = await t.time("base", () => ws.mergeBase(before, head));
			const own = [];
			for (const { oid, commit } of await git.log({ fs: ws.fs, dir: "/repo", ref: head, depth: 50 })) {
				if (oid === stop) break;
				own.push({ commit: oid, message: commit.message.trim(), author: commit.author.name, at: new Date(commit.author.timestamp * 1000).toISOString() });
			}
			return own;
		})
		// Nothing pushed yet (no fork, or no branch on it).
		.catch(() => [] as { commit: string; message: string; author: string; at: string }[]);
	const ids = new Set(commits.map((c) => c.commit));
	const votes = (await votesFor(ctx, repo).readFor([...ids])).votes.filter((v) => ids.has(v.commit));
	return { change, branch, claim: claim ?? null, released, commits, votes };
}

/**
 * A person's vote on a change, from the dashboard: on the change's current
 * commit, stamped with their verified identity (ctx's stamper), counted like
 * any vote (never the author's), and answering any question about it.
 */
export async function freeVoteAsPerson(ctx: FreeContext, repo: string, change: string, input: { role: string; verdict: "approve" | "reject"; evidence: string }, person: string) {
	if (!person.startsWith("person:")) throw new Error("[403] only a person signed in through Access votes from the dashboard; agents use free_vote");
	if (!input.role?.trim()) throw new Error("[400] a vote needs a role");
	if (input.verdict !== "approve" && input.verdict !== "reject") throw new Error("[400] verdict is approve or reject");
	if (typeof input.evidence !== "string" || !input.evidence.trim()) throw new Error("[400] a vote needs evidence: what you checked");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to vote on`);
	const head = await branchHead(await changeSourceFor(ctx, repo)(claim.agent, "read", change), `changes/${change}`).catch(() => null);
	if (!head) throw new Error(`[409] ${change} has nothing pushed to vote on`);
	const stamper = await ctx.stamper?.();
	await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registry, person)).vote({ commit: head, reviewer: person, role: input.role, verdict: input.verdict, evidence: input.evidence }, stamper);
	await ctx.ping?.(repo).catch(() => undefined);
	return { commit: head, role: input.role, verdict: input.verdict };
}

/** The roles Blueprint's own reviewers take on a coordinator-free change: one general review, and every role that can veto. */
export const hostedFreeRoles = (vetoes: string[]) => [...new Set(["review", ...vetoes])];

export async function freeAudit(ctx: FreeContext, repo: string) {
	const { merges, violations } = await runAudit(ctx, repo);
	const open = violations.filter((v) => !v.resolvedBy).length;
	await ctx.summarize?.(repo, { merged: merges, violations: open }).catch(() => undefined);
	return { merges, open, violations };
}

/** What the dashboard shows for a repo in coordinator-free mode, read from the records' tips (the audit is apart, in freeAudit). */
export async function freeSnapshot(ctx: FreeContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const [registry, votes] = await t.time("records", () => Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), votesFor(ctx, repo).read()]));
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] coordinator-free mode hasn't started on ${repo}`);
	const held = await t.time("claims", () => storeFor(ctx, repo, state).read());
	const claims = await t.time("status", () => Promise.all(
		held.claims.map(async (c) => {
			const { head, approval, hosted } = await changeStatus(ctx, repo, state, async () => votes.votes, c.change, c);
			// A question for a person, until a person votes on the change's commit.
			const flag = openFlag(votes, c.change, head);
			const attention = flag ? { reason: flag.reason, agent: flag.agent, at: flag.at } : hosted?.builder?.status === "failed" ? { reason: `Blueprint's builder failed${hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : ""}`, agent: "blueprint-builder", at: c.active } : null;
			return { ...c, head, approval, ...(hosted ? { hosted } : {}), ...(attention ? { attention } : {}) };
		}),
	));
	const waiting = claims.filter((c) => c.attention);
	await ctx.summarize?.(repo, {
		open: claims.length,
		needsYou: waiting.length,
		waiting: waiting.slice(0, 20).map((c) => ({ change: c.change, title: c.intent.split("\n")[0].slice(0, 120), reason: c.attention!.reason.slice(0, 500) })),
		countedAt: new Date().toISOString(),
	}).catch(() => undefined);
	return {
		repo,
		/** The project's branch changes merge into. */
		branch: projectBranch(state),
		policy: state.policy ?? DEFAULT_POLICY,
		verify: state.verify ?? [],
		/** Whether records and merges are stamped with verified identity. */
		verified: !!state.stampKey,
		/** Claims are split into per-path shards this deep (absent: one registry), and since when and why, or whether they will be. */
		...(state.shardDepth ? { shardDepth: state.shardDepth } : {}),
		sharding: shardingOf(state).sharding,
		/** How votes are kept: in one record until the load calls for buckets ("on demand"), always ("never"), or in buckets since `since`. */
		votesSharding: votes.sharded ?? (state.autoShard || state.shardDepth ? "on demand" : "never"),
		/** The claims in force, each with where its change stands. */
		claims,
		/** The latest votes, newest first. */
		votes: votes.votes.slice(-20).reverse(),
	};
}

// Tools that write records, after which the repo's summary notes the activity.
const WRITES = new Set(["free_claim", "free_release", "free_merge", "free_vote", "free_build", "free_revert", "free_ask_human", "free_check", "free_add_work"]);
const noted = new Map<string, number>();

/** Run one coordinator-free tool, and note what it wrote in the repo's summary. */
export async function callFreeTool(name: string, args: Args, ctx: FreeContext): Promise<unknown> {
	const result = await runFreeTool(name, args, ctx);
	if (WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false) await ctx.ping?.(requiredString(args, "repo")).catch(() => undefined);
	if (ctx.summarize && WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false) {
		const repo = requiredString(args, "repo");
		const merged = name === "free_merge";
		// Activity alone is noted at most every 10 seconds per repo, so a busy repo doesn't queue on the index.
		if (merged || Date.now() - (noted.get(repo) ?? 0) > 10_000) {
			noted.set(repo, Date.now());
			await ctx.summarize(repo, { lastActivity: new Date().toISOString(), ...(merged ? { mergedBy: 1 } : {}) }).catch((err) => console.error(`summarizing ${repo} failed`, String(err)));
		}
		// A question for a person belongs in their inbox now, not when someone next opens the repo: the snapshot updates the summary's waiting list.
		if (name === "free_ask_human") await freeSnapshot(ctx, repo).catch((err) => console.error(`updating ${repo}'s inbox failed`, String(err)));
	}
	return result;
}

/** How many claims are in force on a repo, read from its records alone: the repo list's count. Null before the mode starts. */
export async function freeOpenCount(ctx: FreeContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}

async function runFreeTool(name: string, args: Args, ctx: FreeContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	const write = () => ctx.remote(repo, "write");
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const votes = votesFor(ctx, repo);
	// Read once per call; only free_start, which writes it first, reads it again.
	const rootHead = await claims.read();
	const registered = rootHead?.commit.state;
	const key = ctx.agentKey ?? (typeof args.agent_key === "string" ? args.agent_key : undefined);
	const acting = key ? await keyAgent(registered, key) : undefined;
	const actAs = (field: string) => {
		const agent = requiredString(args, field);
		mayActAs(agent, acting, registered, ctx.hosted);
		return agent;
	};
	const stamper = await ctx.stamper?.(acting);
	const store = storeFor(ctx, repo, registered, { log: claims, head: rootHead });
	let viewing: ReturnType<ClaimStore["read"]> | undefined;
	/** The claims in force, read at most once per call. */
	const view = () => (viewing ??= store.read());
	const changes = new Map<string, ReturnType<ClaimStore["readChange"]>>();
	/** One change's claim and releases, read at most once per call, and only from what holds them. */
	const changeOf = (change: string) => {
		if (!changes.has(change)) changes.set(change, store.readChange(change));
		return changes.get(change)!;
	};
	const claimOf = async (change: string) => (await changeOf(change)).claim;
	const changeSource = changeSourceFor(ctx, repo);
	switch (name) {
		case "free_start": {
			const required = typeof args.required === "number" ? args.required : DEFAULT_POLICY.required;
			if (!Number.isInteger(required) || required < 0) throw new Error("[400] required is a whole number of approvals, 0 for none");
			const policy: ReviewPolicy = {
				required,
				vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : DEFAULT_POLICY.vetoes,
				// The default escalation unless the caller sets its own (an empty list for none).
				escalate: Array.isArray(args.escalate) ? (args.escalate as ReviewPolicy["escalate"]) : DEFAULT_POLICY.escalate,
				...(args.grants !== undefined ? { grants: validGrants(args.grants) } : {}),
			};
			const verify = Array.isArray(args.verify) ? (args.verify as string[]).filter((c) => typeof c === "string" && c.trim()) : [];
			// Claims stay in one record until the load calls for shards, unless asked to shard now (or never: 0).
			const asked = typeof args.shard_depth === "number" ? Math.max(0, Math.floor(args.shard_depth)) : undefined;
			// Sharded claims are spread over records repos, where they can be made.
			const wanted = typeof args.records_repos === "number" ? Math.max(0, Math.floor(args.records_repos)) : DEFAULT_RECORDS_REPOS;
			const spread = ctx.recordsRemote && ctx.createRecordsRepos ? wanted : 0;
			const recordsRepos = asked && !registered?.baseline ? spread : 0;
			if (recordsRepos) await ctx.createRecordsRepos!(repo, recordsRepos);
			// Changes merge into the repo's default branch, whatever it's called.
			const branch = registered?.branch ?? (registered?.baseline || !ctx.defaultBranch ? "main" : await ctx.defaultBranch(repo));
			const sharding = asked ? { shardDepth: asked, recordsRepos } : asked === 0 ? {} : { autoShard: { depth: DEFAULT_SHARD_DEPTH, recordsRepos: spread } };
			await startFree(claims, { baseline: await ctx.head(repo, branch), branch, policy, verify, stampKey: stamper?.publicKey, ...sharding });
			await ctx.register?.(repo);
			const registry = (await claims.read())?.commit.state;
			return { repo, branch: projectBranch(registry), policy: registry?.policy ?? policy, verify: registry?.verify ?? [], ...shardingOf(registry), instructions: FREE_INSTRUCTIONS };
		}
		case "free_next": {
			const agent = actAs("agent");
			const [inForce, cast, backlog] = await Promise.all([view(), votes.read(), recordLog<Work>(ctx, repo, workRef(repo)).read()]);
			// Each open change's pushed head, from its author's fork.
			const open = await Promise.all(inForce.claims.map(async (claim) => ({ claim, head: await changeSource(claim.agent, "read", claim.change).then((fork) => branchHead(fork, `changes/${claim.change}`)).catch(() => null) })));
			return nextFor({
				agent,
				...(stamper?.by ? { by: stamper.by } : {}),
				policy: registered?.policy ?? DEFAULT_POLICY,
				open,
				votes: await countedVotes(cast.votes, registered?.stampKey),
				merged: new Set(inForce.released.filter((r) => r.mergedAs).map((r) => r.change)),
				// Its own changes waiting on a person: asked about, not yet answered on their head.
				asked: new Set(open.filter((o) => o.claim.agent === agent && openFlag(cast, o.claim.change, o.head)).map((o) => o.claim.change)),
				work: backlog?.commit.state.items ?? [],
			});
		}
		case "free_add_work": {
			const title = requiredString(args, "title");
			const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : workId(title);
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("[400] a work id is letters, digits, dots, dashes and underscores");
			const paths = args.paths === undefined ? undefined : normalizeClaim(requiredPaths(args, "paths"));
			const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), { id, title, intent: requiredString(args, "intent"), ...(paths ? { paths } : {}), by: actAs("agent") });
			return added.ok ? { ok: true, id } : { ok: false, reason: added.refused };
		}
		case "free_review_access": {
			// Anyone may review: a read-only view of the change's branch in its author's fork (or its own fork, from before forks were per agent).
			const change = requiredString(args, "change");
			const { claim: held, released } = await changeOf(change);
			const author = held?.agent ?? released.at(-1)?.agent;
			if (!author) throw new Error(`[404] no change ${change} on ${repo}`);
			const [fork, project] = await Promise.all([changeSource(author, "read", change), ctx.remote(repo, "read")]);
			const head = await branchHead(fork, `changes/${change}`).catch(() => null);
			if (!head) throw new Error(`[409] ${change} has nothing pushed to review yet`);
			// Agent names only: a person's identity stays in the records, out of logs.
			console.log(`review access to ${repo} ${change} (${author}) for ${acting ?? "an unregistered caller"}`);
			return { change, author, url: fork.url, token: fork.token, branch: `changes/${change}`, head, project: { url: project.url, token: project.token, branch: projectBranch(registered) } };
		}
		case "free_credentials": {
			if (typeof args.change !== "string" || !args.change.trim()) {
				const remote = await ctx.remote(repo, "read");
				return { url: remote.url, token: remote.token, note: "read-only: the project repo is written only through the toolkit. Ask with your change for write access to its fork." };
			}
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			if (!own) throw new Error(`[409] ${change} holds no claim: claim its paths first`);
			mayActAs(own.agent, acting, registered, ctx.hosted);
			// The agent's own fork, made on its first change and reused for the rest. Its default branch may be
			// behind the project's, so a new change starts from the project, read with `project`.
			const [remote, project] = await Promise.all([changeSource(own.agent, "write"), ctx.remote(repo, "read")]);
			const branch = projectBranch(registered);
			return {
				url: remote.url,
				token: remote.token,
				branch: `changes/${change}`,
				project: { url: project.url, token: project.token, branch },
				note: `Your own fork, for all your changes: push this change's branch changes/${change} to it. Start the branch from the project's ${branch} (project), not the fork's, which may be behind.`,
			};
		}
		case "free_claims":
			return (await view()).claims;
		case "free_claim": {
			const input = { change: requiredString(args, "change"), agent: actAs("agent"), paths: normalizeClaim(requiredPaths(args, "paths")), intent: requiredString(args, "intent"), staleAfterMs: STALE_AFTER_MS };
			// Busy enough that one record would hold agents up: shard first, then claim in the shards.
			const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
			return (sharded ? storeFor(ctx, repo, sharded) : store).claim(input, stamper);
		}
		case "free_release": {
			const change = requiredString(args, "change");
			const agent = actAs("agent");
			if (args.stale === true) return store.releaseStale({ change, agent, staleAfterMs: STALE_AFTER_MS }, stamper);
			return store.release({ change, agent, reason: typeof args.reason === "string" ? args.reason : "released" }, stamper);
		}
		case "free_ask_human": {
			const change = requiredString(args, "change");
			if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim`);
			return votes.flag({ change, agent: actAs("agent"), reason: requiredString(args, "reason") }, stamper);
		}
		case "free_vote": {
			const verdict = requiredString(args, "verdict");
			if (verdict !== "approve" && verdict !== "reject") throw new Error("[400] verdict is approve or reject");
			const reviewer = actAs("reviewer");
			// Busy enough that one record would hold reviewers up: shard the votes first.
			return votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote({ commit: requiredString(args, "commit"), reviewer, role: requiredString(args, "role"), verdict, evidence: requiredString(args, "evidence") }, stamper);
		}
		case "free_merge": {
			// mergeChange reads the claims again itself, when it checks them.
			const registry = registered;
			// Anyone may merge a change whose conventions hold; it merges as its claim's agent, and the stamp says who asked.
			const change = requiredString(args, "change");
			const holder = (await claimOf(change))?.agent;
			if (holder && holder !== requiredString(args, "agent")) throw new Error(`[409] ${change} is ${holder}'s change: merge it as ${holder}`);
			return mergeChange({
				remote: await write(),
				branch: projectBranch(registry),
				store,
				votes,
				policy: registry?.policy ?? DEFAULT_POLICY,
				verify: registry?.verify ?? [],
				runChecks: ctx.runChecks?.(repo),
				stamper,
				stampKey: registry?.stampKey,
				source: await changeSource(holder ?? requiredString(args, "agent"), "read", change),
				change,
				agent: requiredString(args, "agent"),
			});
		}
		case "free_build": {
			if (!ctx.startBuilder) throw new Error("[501] hosted builders aren't available here");
			const intent = requiredString(args, "intent");
			const change = changeId(intent);
			const claimed = await store.claim({ change, agent: "blueprint-builder", paths: normalizeClaim(requiredPaths(args, "paths")), intent, staleAfterMs: STALE_AFTER_MS }, stamper);
			if (!claimed.ok) return claimed;
			return ctx.startBuilder({ repo, change });
		}
		case "free_request_review": {
			const change = requiredString(args, "change");
			const registry = registered;
			if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim: claim the change's paths first`);
			if (!ctx.requestReview) throw new Error("[501] hosted reviewers aren't available here");
			const policy = registry?.policy ?? DEFAULT_POLICY;
			// By default a general review, and every role that can veto a change to these paths.
			const roles = Array.isArray(args.roles) && args.roles.length ? (args.roles as string[]) : hostedFreeRoles(effectiveFreePolicy(policy, (await claimOf(change))?.paths ?? []).vetoes);
			return ctx.requestReview({ repo, change, roles, ...(typeof args.summary === "string" ? { summary: args.summary } : {}) });
		}
		case "free_audit": {
			const { merges, violations } = await runAudit(ctx, repo);
			return { merges, open: violations.filter((v) => !v.resolvedBy).length, violations };
		}
		case "free_revert": {
			const { violations } = await runAudit(ctx, repo);
			return revertViolation({ remote: await write(), branch: projectBranch(registered), claims, votes, stamper, target: requiredString(args, "commit"), violations, agent: actAs("agent") });
		}
		case "free_status": {
			const change = requiredString(args, "change");
			const held = (await claimOf(change)) ?? null;
			const released = held ? undefined : (await changeOf(change)).released.at(-1);
			const votesOn = async (head: string) => (await votes.readFor([head])).votes;
			return { change, claim: held, ...(released ? { released } : {}), ...(await changeStatus(ctx, repo, registered, votesOn, change, held ?? undefined, held?.agent ?? released?.agent)) };
		}
		case "free_check":
		{
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			const source = own ? await changeSource(own.agent, "read", change).catch(() => null) : null;
			if (!source) throw new Error(`[409] changes/${change} has nothing pushed to check`);
			return checkChange({ project: await ctx.remote(repo, "read"), branch: projectBranch(registered), source, claims: own ? [own] : [], change });
		}
		case "free_register": {
			const agent = requiredString(args, "agent");
			if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted) throw new Error("[403] blueprint- names are Blueprint's hosted agents'");
			const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const newKey = `${agent}.${secret}`;
			const outcome = await registerAgent(claims, { agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) }, stamper);
			if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
			return { agent, key: newKey, note: "Keep this key secret; it is shown once. Send it as X-Blueprint-Agent-Key (or agent_key) with every call." };
		}
		default:
			throw new Error(`[400] unknown tool ${name}`);
	}
}
