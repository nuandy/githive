import { requiredString, statusOf } from "../../errors";
import type { Remote } from "../../git";
import type { GitHubLink } from "../../github";
import type { GitHubSyncHandle } from "../github-settings";
import type { HiveEvent } from "../../hive-events";
import { projectBranch } from "../../project-branch";
import { GitCasLog } from "../../record-log";
import { Timing } from "../../timing";
import type { ReadHistory, SharedPlacements } from "../batch-reads";
import { presentClaim } from "../branch-scope";
import type { ClaimStore } from "../claim-store";
import type { ClaimRecord, Registry } from "../claims";
import type { BranchCommit } from "../git-records";
import type { Landed, Landing } from "../landing";
import { atMost, type BatchChange, type BatchGit, type CheckRunner } from "../merge";
import { abandoned } from "../staleness";
import type { Stamper } from "../stamp";
import type { VoteStore } from "../vote-store";
import { countedVotes } from "../votes";
import type { Work } from "../work";
import { changeHead, changeSigns, changeSourceFor } from "./change-state";
import { keyAgent, mayActAs } from "./identity";
import {
	branchSettings,
	claimsRef,
	containerChecks,
	DEFAULT_POLICY,
	recordLog,
	storeFor,
	votesFor,
	workRef,
} from "./repo";

// The context every tool works with: what the Worker provides (ToolContext), and for each call,
// the repo's records as read once for that call (openCall).

export interface ToolContext {
	/** Credentials for a project repo. */
	remote: (repo: string, scope: "read" | "write") => Promise<Remote>;
	/** Shared record logs (claims, votes), so an unchanged ref isn't fetched again on every call. */
	records?: <S>(repo: string, ref: string) => GitCasLog<S>;
	/** Credentials for records repo `k`, which holds claim shards once they're spread out. */
	recordsRemote?: (repo: string, k: number, scope: "read" | "write") => Promise<Remote>;
	/** Harmless if the records repos already exist. */
	createRecordsRepos?: (repo: string, count: number) => Promise<void>;
	/** Credentials for an agent's own fork, where its change branches live. Asking to write creates the fork. */
	changeRemote?: (repo: string, agent: string, scope: "read" | "write") => Promise<Remote>;
	/** Read access to a per-change fork, from before forks were per agent. */
	legacyChangeRemote?: (repo: string, change: string) => Promise<Remote>;
	head: (repo: string, branch: string) => Promise<string>;
	/** The branch the repo's HEAD points to. Without it, main is assumed. */
	defaultBranch?: (repo: string) => Promise<string>;
	/** Runs the repo's checks on its branch plus a batch of changes, in the Gate's container. */
	runChecks?: (repo: string) => CheckRunner;
	/** A branch's commits since `baseline`, read with git in the repo's Gate. Without it, read in memory. */
	readBranch?: (repo: string, baseline: string, branch: string) => Promise<BranchCommit[]>;
	/** Where a batch's git work runs (the repo's Gate). Without it, nothing can land. */
	batchGit?: (repo: string) => BatchGit;
	/** Reads a repo's history through Artifacts' API. The Gate reads only the batch changes this can't place. */
	history?: ReadHistory;
	/** A branch's head in an agent's fork, through Artifacts' API: null if no branch, a [409] if no fork. */
	forkHead?: (repo: string, agent: string, ref: string) => Promise<string | null>;
	/** Starts a batch's first check container while the batch is being read. */
	prepareChecks?: (repo: string) => (gate: string) => Promise<void>;
	/** Starts the repo's Gate while a batch is being read, so it's ready to land it. */
	prepareLanding?: (repo: string) => Promise<void>;
	/** Places a change on `branch`, and fetches it for its landing, while its merge waits for its turn. */
	prefetchChange?: (repo: string, branch: string, change: BatchChange) => Promise<void>;
	/** Changes' places on a branch, kept for every Worker instance gathering a batch. */
	placements?: (repo: string) => SharedPlacements;
	/** The batch landing on a branch and its recent outcomes. Without it, a merge knows only its own. */
	landing?: (repo: string, branch: string) => Landing;
	/** Stamps what this caller writes with their verified identity and agent name. Without it, nothing is stamped. */
	stamper?: (agent?: string) => Promise<Stamper | undefined>;
	/** The caller's agent key from register, sent in the X-GitHive-Agent-Key header. */
	agentKey?: string;
	/** The signed-in caller's name, <handle>/<agent>, verified by an agent token or OAuth grant. It needs no key. */
	agent?: string;
	/** Whether the caller may start hosted agents (build, request_review), which spend its model account. */
	mayUseHosted?: () => Promise<boolean>;
	/** The caller's teams in the repo's org (@<org>/<team>), recorded in their votes. */
	teamsOf?: (repo: string) => Promise<string[]>;
	/** Set for GitHive's hosted agents, which act under the reserved githive- names. */
	hosted?: boolean;
	/** Records the repo so the dashboard can list it. */
	register?: (repo: string) => Promise<void>;
	/** Starts hosted reviewers on a change's current commit. Each votes, and merges the change if asked to. */
	requestReview?: (input: {
		repo: string;
		change: string;
		roles: string[];
		summary?: string;
		mergeWhenApproved?: boolean;
	}) => Promise<{ head: string; reviewers: string[] }>;
	/** What the hosted builder and reviewers of a change are doing. */
	agentStatus?: (repo: string, change: string, head: string | null, roles: string[]) => Promise<HostedStatus>;
	/** Times a request's steps, for its Server-Timing header. */
	timing?: Timing;
	/** Tells the dashboard's open pages that the repo's records changed, and how, for the hive's feed. */
	ping?: (repo: string, event?: HiveEvent) => Promise<void>;
	/** Warms the repo's check container in the background when a merge is likely soon (see Gate.warmUp). */
	warmChecks?: (
		repo: string,
		input: { branch: string; checks: string[]; expect: "claimed" | "checked" | "approved" | "set up"; key?: string },
	) => Promise<void>;
	/**
	 * A cached copy of the claims in force and merged changes, for advice (claims, reviews, backlog) that tolerates
	 * slight staleness. Claims and merges never use it: they read their own records in Git.
	 */
	keptClaims?: (repo: string, read: () => Promise<ClaimsAdvice>) => Promise<ClaimsAdvice>;
	/**
	 * The latest head seen on each claim's branch (null if nothing is pushed) and when, kept in the repo's
	 * RepoCache. `pushed` marks a head reported by a push event (see openHeads).
	 */
	knownHeads?: (
		repo: string,
		claims: { change: string; agent: string }[],
	) => Promise<Record<string, { head: string | null; at: number; pushed?: boolean }>>;
	/** Records the heads a tool read (null if nothing is pushed), as of `readAt` (default now). */
	noteHeads?: (repo: string, headsRead: Record<string, string | null>, readAt?: number) => Promise<void>;
	/** Each change's merge check as status last worked it out, kept by the heads it was worked out on. */
	mergeChecks?: {
		kept: (repo: string, change: string) => Promise<{ key: string; result: unknown } | null>;
		keep: (repo: string, change: string, kept: { key: string; result: unknown }) => Promise<void>;
	};
	/** A GitHub repo (owner/name) through GitHive's App, or null if the App isn't installed. Unset without GitHub. */
	github?: (repo: string) => Promise<GitHubLink | null>;
	/** The repo's GitHubSync: the job bringing GitHub's changes back, and the pull request as last seen. */
	githubSync?: (repo: string) => GitHubSyncHandle;
	/** What landed on a branch since this agent was last told (see RepoCache.landingNews). */
	news?: (repo: string, branch: string, agent: string) => Promise<Landed[]>;
	/** A branch's head, briefly cached and shared by the merges watching it (see MergeInput.branchHead). */
	branchHead?: (repo: string, branch: string) => Promise<string | null>;
	/** Queues forks to be made in the background: the repo's seeds, or the named agents' own. */
	prepareForks?: (repo: string, items: "seeds" | string[]) => Promise<void>;
	/**
	 * Review holds set by credentials for a change under review, so the reviews tool shows which are taken
	 * (see review-holds.ts).
	 */
	reviews?: {
		/** The holds on these heads, by holdKey; on every head when none are named. */
		held(repo: string, heads?: string[]): Promise<Record<string, string[]>>;
		hold(repo: string, head: string, agent: string, needed: number): Promise<boolean>;
		release(repo: string, head: string, agent: string): Promise<void>;
		/** When each waiting blocking-role review (by holdKey) was first seen, and whether people were told. */
		waits?(repo: string, keys: string[]): Promise<Record<string, { since: number; told?: boolean }>>;
		told?(repo: string, key: string): Promise<void>;
	};
	/** Updates the repo's summary in the dashboard's repo list. It's a hint; Git is the source of truth. */
	summarize?: (
		repo: string,
		patch: {
			open?: number;
			needsYou?: number;
			waiting?: { change: string; title: string; reason: string }[];
			merged?: number;
			mergedBy?: number;
			violations?: number;
			lastActivity?: string;
			countedAt?: string;
		},
	) => Promise<void>;
	/** Starts GitHive's hosted builder on a claimed change. */
	startBuilder?: (input: { repo: string; change: string }) => Promise<{ change: string; builder: string }>;
}

export interface HostedStatus {
	builder?: { status: string; revisions: number; error?: string };
	reviewers: { role: string; status: string; verdict?: string }[];
}

/** How long a change's head, once seen, is taken as current (see openHeads). */
const HEAD_SEEN_MS = 5 * 60_000;

/** How long a head reported by a push event stays current. Reads only catch a lost event. */
const HEAD_PUSHED_MS = 30 * 60_000;

/** How many stale or unseen heads one call reads (see openHeads). */
const HEAD_READS_PER_CALL = 6;

/** Concurrent fork head reads. A Worker request holds at most six connections; the runtime cancels any past that. */
const HEAD_READS_AT_ONCE = 6;

export type Args = Record<string, unknown>;

/** What the advice tools (claims, reviews, backlog) read: the claims in force and the changes merged. */
export interface ClaimsAdvice {
	claims: ClaimRecord[];
	merged: string[];
}

/** What a tool call works with: the repo's records as read once for this call, and helpers over them. */
export async function openCall(args: Args, ctx: ToolContext, run: RunTool) {
	const repo = requiredString(args, "repo");
	const write = () => ctx.remote(repo, "write");
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const votes = votesFor(ctx, repo);
	// Read once per call. Only settings, when it starts GitHive, reads it again after writing it.
	const rootHead = await claims.read();
	const registered = rootHead?.commit.state;
	const { acting, agentArg, actAs } = await callerOf(args, ctx, registered);
	const stamper = await ctx.stamper?.(acting);
	const store = storeFor(ctx, repo, registered, { log: claims, head: rootHead });
	// Changes land on the project's branch unless their claim names another with `into`.
	const branch = projectBranch(registered);
	const { adviceView, changeOf, claimOf, waitingOn } = claimViews(ctx, repo, store, branch);
	const changeSource = changeSourceFor(ctx, repo);
	const openHeads = (claims: ClaimRecord[], fresh: (claim: ClaimRecord) => boolean = () => false) =>
		readOpenHeads(ctx, repo, claims, fresh);
	const openWork = (agent: string) =>
		readOpenWork({ ctx, repo, branch, registered, stamper, votes, adviceView, openHeads }, agent);
	const warmChecks = gateWarmer(ctx, repo, registered);
	return {
		args,
		ctx,
		run,
		repo,
		write,
		claims,
		votes,
		registered,
		acting,
		agentArg,
		actAs,
		stamper,
		store,
		branch,
		adviceView,
		changeOf,
		claimOf,
		waitingOn,
		changeSource,
		openHeads,
		openWork,
		warmChecks,
	};
}

/** Who the call is from: a signed-in agent, or the agent its key names; and the agent each argument names. */
async function callerOf(args: Args, ctx: ToolContext, registered: Registry | undefined) {
	const key = ctx.agentKey ?? (typeof args.agent_key === "string" ? args.agent_key : undefined);
	// A signed-in agent is who its token says; otherwise an agent key names the agent.
	const acting = ctx.agent ?? (key ? await keyAgent(registered, key) : undefined);
	// A signed-in agent may leave its name out.
	const agentArg = (field: string) => {
		const given = typeof args[field] === "string" && args[field].trim();
		return ctx.agent && !given ? ctx.agent : requiredString(args, field);
	};
	const actAs = (field: string) => {
		const agent = agentArg(field);
		mayActAs(agent, acting, registered, ctx.hosted);
		return agent;
	};
	return { acting, agentArg, actAs };
}

/** The claims as read once for this call, each change's at most once, presented on the branch they land on. */
function claimViews(ctx: ToolContext, repo: string, store: ClaimStore, branch: string) {
	const present = <C extends ClaimRecord>(claim: C) => presentClaim(claim, branch);
	let viewing: ReturnType<ClaimStore["read"]> | undefined;
	const view = () => (viewing ??= store.read().then((stored) => ({ ...stored, claims: stored.claims.map(present) })));
	const adviceView = async (): Promise<ClaimsAdvice> => {
		const read = async () => {
			const current = await view();
			const merged = current.released.filter((release) => release.mergedAs).map((release) => release.change);
			return { claims: current.claims, merged };
		};
		return ctx.keptClaims ? ctx.keptClaims(repo, read) : read();
	};
	const changes = new Map<string, ReturnType<ClaimStore["readChange"]>>();
	const changeOf = (change: string) => {
		if (!changes.has(change))
			changes.set(
				change,
				store
					.readChange(change)
					.then((stored) => (stored.claim ? { ...stored, claim: present(stored.claim) } : stored)),
			);
		return changes.get(change)!;
	};
	const claimOf = async (change: string) => (await changeOf(change)).claim;
	// Why `dependency` still holds up a change into `into`, or null once it merged there.
	const dependencyWait = async (dependency: string, into: string) => {
		const merged = (await changeOf(dependency)).released.filter((release) => release.mergedAs).at(-1);
		if (!merged) return `waits on ${dependency}, which hasn't merged yet`;
		const landed = merged.into ?? branch;
		return landed === into ? null : `waits on ${dependency}, which merged into ${landed}, not ${into}`;
	};
	// Each dependency in `after` not yet merged into `into`, described for the agent.
	const waitingOn = async (after: string[], into: string) => {
		const waits = await Promise.all(after.map((dependency) => dependencyWait(dependency, into)));
		return waits.filter((wait): wait is string => !!wait);
	};
	return { adviceView, changeOf, claimOf, waitingOn };
}

/** Warms the repo's Gate ahead of a likely merge: for its checks, or without any, for its landing. */
function gateWarmer(ctx: ToolContext, repo: string, registered: Registry | undefined) {
	return async (expect: "claimed" | "checked" | "approved", key: string) => {
		if (registered?.baseline)
			await ctx
				.warmChecks?.(repo, {
					branch: projectBranch(registered),
					checks: containerChecks(registered.verify),
					expect,
					key,
				})
				.catch(() => undefined);
	};
}

type OpenChange = { claim: ClaimRecord; head: string | null };

// Null when nothing is pushed (no fork, or no branch on it); undefined when the read failed,
// which says nothing either way.
const pushedHead = (ctx: ToolContext, repo: string, claim: ClaimRecord) =>
	changeHead(ctx, repo, claim.agent, claim.change, claim.since).catch((err): null | undefined =>
		statusOf(err).status === 409 ? null : undefined,
	);

// Open changes' pushed heads: the caller's own (`fresh`) read now, the rest as last seen (see knownHeads).
// Reading every fork on every call dominated GitHive's Git traffic, so a call reads only a few stale
// heads, least recently seen first. Without knownHeads, all are read.
async function readOpenHeads(
	ctx: ToolContext,
	repo: string,
	claims: ClaimRecord[],
	fresh: (claim: ClaimRecord) => boolean,
) {
	const owners = claims.map((claim) => ({ change: claim.change, agent: claim.agent }));
	const known = ctx.knownHeads ? await ctx.knownHeads(repo, owners).catch(() => undefined) : undefined;
	const now = Date.now();
	const seenAt = (claim: ClaimRecord) => known?.[claim.change]?.at ?? 0;
	const currentFor = (claim: ClaimRecord) => (known?.[claim.change]?.pushed ? HEAD_PUSHED_MS : HEAD_SEEN_MS);
	const current = (claim: ClaimRecord) => now - seenAt(claim) <= currentFor(claim);
	const due = claims.filter((claim) => !fresh(claim) && !current(claim)).sort((a, b) => seenAt(a) - seenAt(b));
	const reading = known ? [...claims.filter(fresh), ...due.slice(0, HEAD_READS_PER_CALL)] : claims;
	const read = new Map(
		await atMost(
			HEAD_READS_AT_ONCE,
			reading,
			async (claim) => [claim.change, await pushedHead(ctx, repo, claim)] as const,
		),
	);
	const headsRead = Object.fromEntries(
		[...read].filter((entry): entry is [string, string | null] => entry[1] !== undefined),
	);
	// Timestamped when the reads began, so a push event since then wins.
	if (Object.keys(headsRead).length) await ctx.noteHeads?.(repo, headsRead, now).catch(() => undefined);
	return (claim: ClaimRecord) => read.get(claim.change) ?? known?.[claim.change]?.head ?? null;
}

// What a call's open work is read from (see readOpenWork).
interface WorkSources {
	ctx: ToolContext;
	repo: string;
	branch: string;
	registered: Registry | undefined;
	stamper: Stamper | undefined;
	votes: VoteStore;
	adviceView: () => Promise<ClaimsAdvice>;
	openHeads: (
		claims: ClaimRecord[],
		fresh?: (claim: ClaimRecord) => boolean,
	) => Promise<(claim: ClaimRecord) => string | null>;
}

// The repo's open work as `agent` sees it, for reviews and backlog. A change that landed at its current
// head counts as merged even before its claim is released, so nobody is offered it to merge again.
async function readOpenWork(sources: WorkSources, agent: string) {
	const { ctx, repo, branch, registered, stamper, votes, adviceView, openHeads } = sources;
	const [inForce, votesCast, backlog, landing] = await Promise.all([
		adviceView(),
		votes.read(),
		recordLog<Work>(ctx, repo, workRef(repo)).read(),
		ctx
			.landing?.(repo, branch)
			.view()
			.catch(() => null) ?? null,
	]);
	const heads = await openHeads(inForce.claims, (claim) => claim.agent === agent);
	const landedNow = new Set(
		(landing?.recent ?? [])
			.filter((settled) => settled.how === "landed")
			.map((settled) => `${settled.change} ${settled.head}`),
	);
	const landedHere = (claim: ClaimRecord) => !claim.into && landedNow.has(`${claim.change} ${heads(claim)}`);
	const open = inForce.claims.filter((claim) => !landedHere(claim)).map((claim) => ({ claim, head: heads(claim) }));
	const counted = await countedVotes(votesCast.votes, registered?.stampKey);
	const teams = (await ctx.teamsOf?.(repo)) ?? [];
	const isAbandoned = ({ claim, head }: OpenChange) =>
		abandoned(
			changeSigns({
				claim,
				head,
				counted,
				record: votesCast,
				landing: claim.into ? null : landing,
				policy: branchSettings(registered, claim.into).policy,
			}),
			Date.now(),
		).abandoned;
	return {
		agent,
		...(stamper?.by ? { by: stamper.by } : {}),
		...(teams.length ? { teams } : {}),
		policy: registered?.policy ?? DEFAULT_POLICY,
		// Each change's policy comes from the branch it lands on.
		policyOf: (claim: ClaimRecord) => branchSettings(registered, claim.into).policy,
		open,
		votes: counted,
		merged: new Set([...inForce.merged, ...inForce.claims.filter(landedHere).map((claim) => claim.change)]),
		work: backlog?.commit.state.items ?? [],
		abandoned: new Set(open.filter(isAbandoned).map((change) => change.claim.change)),
	};
}

/** Runs a tool by name, as callTool does without its news and summary (see mcp.ts). */
export type RunTool = (name: string, args: Args, ctx: ToolContext) => Promise<unknown>;
export type ToolCall = Awaited<ReturnType<typeof openCall>>;
export type ToolHandlers = Record<string, (call: ToolCall) => Promise<unknown>>;
