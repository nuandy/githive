import git from "isomorphic-git";
import { GitCasLog } from "../record-log";
import { fail, requiredPaths, requiredString } from "../errors";
import { branchHead, type Remote, Workspace } from "../git";
import { projectBranch } from "../project-branch";
import { Timing } from "../timing";
import { annotate, destroys, reads, writes } from "../tool-annotations";
import { changeId, claimCovering, normalizeClaim } from "../claim-paths";
import { audit } from "./audit";
import { checkChange } from "./check";
import { claimStore, type ClaimStore } from "./claim-store";
import { changeSettings, recordBranch, registerAgent, shardClaims, shardingReason, startRepo, type ClaimRecord, type Registry } from "./claims";
import { readMainMerges, readRecordHistory, readRefHistories, readShardHistories } from "./git-records";
import { type CheckRunner, mergeChange } from "./merge";
import { revertViolation } from "./revert";
import type { Stamper } from "./stamp";
import { SENSITIVE_PATHS, approval, countedVotes, DEFAULT_GRANT, effectivePolicy, grantWarnings, openFlag, shardVotes, votesShardingReason, type ReviewPolicy, type VoteRecord, type Votes } from "./votes";
import { VOTE_BUCKETS, type VoteStore, voteStore, votesPrefix } from "./vote-store";
import { addWork, holdKey, type NextStep, nextFor, ROLE_WAIT_MS, type Work, waitingRoleReviews, workId } from "./work";
import { type Line, lineRef } from "./line";
import { abandoned, BUILDING_IDLE_MS, type ChangeSigns } from "./staleness";
import { claimInto, isReservedPath, presentClaim, scopeFile, scopePaths } from "./branch-scope";
import { BRANCH_PATTERN, type BranchRule, settingsForBranch } from "./branch-rules";
import type { Abandoned } from "./claims";

// GitHive's MCP tools (see docs/design.md). Stateless: each
// tool reads or writes the repo's records in Git and reports what Git said.
// Nothing here decides for anyone; an agent can do the same with plain git,
// and the audit reads the same records either way.

export interface ToolContext {
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
	/** Checks in the repo's line into `branch` (absent: the project's branch). */
	runChecks?: (repo: string, branch?: string) => CheckRunner;
	/** Stamps what this caller writes with their verified identity (GitHive's key), and the agent name their key is for; without it, nothing is stamped. */
	stamper?: (agent?: string) => Promise<Stamper | undefined>;
	/** The caller's agent key (register), from the X-GitHive-Agent-Key header. */
	agentKey?: string;
	/** The caller's agent name, verified by GitHive's sign-in (an agent token or an OAuth grant): <handle>/<agent>. It needs no key. */
	agent?: string;
	/** Whether the caller may start GitHive's hosted agents (build, request_review), which spend its model account; unset, they may. */
	mayUseHosted?: () => Promise<boolean>;
	/** The teams the caller is on in a repo's org (@<org>/<team>), as GitHive checks them: recorded in their votes. */
	teamsOf?: (repo: string) => Promise<string[]>;
	/** GitHive's own hosted agents, who act under the reserved githive- names. */
	hosted?: boolean;
	/** Notes a repo, so the dashboard can list it. */
	register?: (repo: string) => Promise<void>;
	/** Starts GitHive's hosted reviewers on a change's current commit; each votes with vote (and, asked to, then tries to merge it). */
	requestReview?: (input: { repo: string; change: string; roles: string[]; summary?: string; mergeWhenApproved?: boolean }) => Promise<{ head: string; reviewers: string[] }>;
	/** What GitHive's hosted agents on a change are doing: its builder, and the reviewers of its head. */
	agentStatus?: (repo: string, change: string, head: string | null, roles: string[]) => Promise<HostedStatus>;
	/** Times a request's steps, for its Server-Timing header. */
	timing?: Timing;
	/** Tells the dashboard's open pages that the repo's records changed. */
	ping?: (repo: string) => Promise<void>;
	/** Warms the repo's check container in the background, when a merge is likely soon: why, and for what (see Gate.warmLanes). */
	warmChecks?: (repo: string, input: { branch: string; checks: string[]; expect: "checked" | "approved" | "set up"; key?: string }) => Promise<void>;
	/**
	 * A kept copy of the repo's claims in force and the changes merged,
	 * rebuilt after writes (stale while one caller rebuilds it): for advice
	 * that a moment's staleness doesn't harm (the claims tool, next), so a
	 * busy repo isn't read whole on every call. Never for a claim or a merge,
	 * which read their own records in Git. Unset: read every time.
	 */
	keptClaims?: (repo: string, read: () => Promise<ClaimsAdvice>) => Promise<ClaimsAdvice>;
	/** The open changes' pushed heads, by change, kept a few seconds the same way (for next). */
	keptHeads?: (repo: string, read: () => Promise<Record<string, string | null>>) => Promise<Record<string, string | null>>;
	/** Review holds, so next doesn't send two agents to a review that needs one (see review-holds.ts). */
	reviews?: {
		held(repo: string): Promise<Record<string, string[]>>;
		hold(repo: string, head: string, agent: string, needed: number): Promise<boolean>;
		release(repo: string, head: string, agent: string): Promise<void>;
		/** When each waiting review a role that can block awaits (by holdKey) was first seen, and whether people were told. */
		waits?(repo: string, keys: string[]): Promise<Record<string, { since: number; told?: boolean }>>;
		told?(repo: string, key: string): Promise<void>;
	};
	/** Updates the repo's summary for the dashboard's list of repos (a hint; Git is what counts). */
	summarize?: (repo: string, patch: { open?: number; needsYou?: number; waiting?: { change: string; title: string; reason: string }[]; merged?: number; mergedBy?: number; violations?: number; lastActivity?: string; countedAt?: string }) => Promise<void>;
	/** Starts GitHive's hosted builder on a claimed change. */
	startBuilder?: (input: { repo: string; change: string }) => Promise<{ change: string; builder: string }>;
}

export interface HostedStatus {
	builder?: { status: string; revisions: number; error?: string };
	reviewers: { role: string; status: string; verdict?: string }[];
}

/** One approval by default; a change to dependency, CI or deploy files also needs security's, who can veto it. */
export const DEFAULT_POLICY: ReviewPolicy = { required: 1, vetoes: [], escalate: [{ paths: SENSITIVE_PATHS, required: 2, vetoes: ["security"] }] };
const HOSTED_PREFIX = "githive-";
const DEFAULT_SHARD_DEPTH = 2;
/** Records repos per sharded repo, where they're available: Artifacts takes one push at a time per repo. */
const DEFAULT_RECORDS_REPOS = 16;
/** The floor: no claim is stale sooner than this after its agent last claimed (see staleness.ts for the rest of the rule). */
const STALE_AFTER_MS = BUILDING_IDLE_MS;
const claimsRef = (repo: string) => `refs/notes/githive-claims/${repo}`;
const votesRef = (repo: string) => `refs/notes/githive-votes/${repo}`;
const workRef = (repo: string) => `refs/notes/githive-work/${repo}`;

export const INSTRUCTIONS = `GitHive: many agents work on one repository at once. Nobody enforces the rules; every agent follows them, and an audit anyone can run shows who didn't.
Name a repo as <owner>/<name> (a person's or an org's), as on GitHub; what you may do in it depends on your permission there (read, review, write, admin), and an agent has its owner's.
Not sure what to do? Call \`next\`: it tells you the most useful thing for you now: merge or revise your own change, review someone else's, or build a piece of the backlog (\`add_work\` adds to it). Do it, then ask again.
Conventions:
1. \`claim\` the paths you will change before editing; edit only inside your claim. A refusal names who holds what: narrow your claim, or ask them. A change lands on the project's branch unless its claim says \`into\` another (a feature branch, a release branch); claims are per branch, so the same paths on two branches don't conflict. A branch that doesn't exist yet is made by the claim when you also say \`from\` (the branch to make it from).
Work that depends on other unmerged work goes on a feature branch, and the project's branch only receives finished features. Within a branch, \`after\` orders it: a change claimed with after: [x] merges only once x has merged into the same branch. A branch may have settings of its own (\`settings\` branch_rules: feature/* with checks only, say, or release/* needing a person's approval): \`status\` shows what a change needs on its branch. A finished branch merges into another as one change: \`claim\` with \`source\` (the branch to merge) and \`into\`; the claim is what the branch changed, its tip becomes your change, and it's reviewed, checked and merged like any other. A conflict with the branch it lands on is fixed by merging that branch into the source the same way, then claiming again.
2. Work on a branch changes/<change>, started from the branch the change lands on (the project's, or its claim's \`into\`: \`credentials\` names it), and push it to your own fork (\`credentials\` with your change: one fork per agent, for all its changes; only you can write it). The project's branch (\`start\` names it: main, master, ...) is written only through the toolkit.
3. Reviewers get the change's code with \`review_access\` (read-only: its branch in the author's fork, and the project to diff against), then \`vote\` on the exact commit they reviewed. A change merges with the policy's approvals, including every veto role's, and no veto; a veto role counts only from whoever \`start\` granted it (by default people and GitHive's reviewers), so \`register\` with your key to vote as one. Approvals count once per verified identity (register reviewers so each is its own), and never the change's author. \`status\` shows your change's votes, with the evidence for any rejection to fix, and what's still needed.
4. Run \`check\` after you push: it test-merges your change with the branch it lands on and lists files outside your claim, so you hear about problems before merging.
5. \`merge\` merges your branch with trailers recording the claims and votes it checked, then releases your claim. Merge by hand only with the same trailers.
6. Claiming again (same paths) keeps your claim active. A claim is freed only when its change waits on its own agent and gets no answer: 30 minutes with nothing pushed, or 2 hours after changes were asked for, its checks failed in the merge line, or it was approved and not merged. Then whoever claims its paths (or its change) releases it, as can anyone (\`release\` with stale: true). A change waiting for review, in the merge line, or on a person is never freed.
7. Anyone may \`revert\` a commit \`audit\` reports; the audit then counts it resolved.
8. Something agents can't settle (reviewers disagree, a trade-off needs an owner)? \`ask_human\` with the reason: a person sees it in their inbox and decides with their own vote.
9. \`request_review\` asks GitHive's hosted reviewers for votes on your change; \`build\` has GitHive's hosted builder make a change from start to merge.
10. Who you are: signed in to GitHive (OAuth, or an agent token), you are your agent, <handle>/<agent>, with nothing more to do. Agents that share an Access identity instead tell themselves apart with \`register\`: it returns your agent key once; send it (header X-GitHive-Agent-Key, or agent_key) with every call, and what you write is attributed to you. A registered name is never used without its key.
\`audit\` replays the records and lists every broken convention, with the commit and the agent.`;

const str = { type: "string" } as const;
const TOOL_LIST = [
	{ name: "start", description: "Start GitHive on a project repo (harmless if started; change a started repo's policy or checks with settings): the review policy, the checks run before each merge (each change lives in its own fork, and only the toolkit writes the project), grants: who may vote as each role that can block a merge (registered agent names, 'person:*', a verified identity like 'person:<who>' or 'service:<id>', a pool 'service:<id>/*' (every agent registered under it, never on its own team's changes), 'githive' for GitHive's reviewers; unlisted roles: people and GitHive's reviewers), how claims are kept: in one record until the load calls for more (8 agents holding claims, or over 15 claim writes a minute), then sharded per path 2 segments deep over 16 records repos, so agents in different parts of the tree never contend. shard_depth shards now, this deep (0: never), and records_repos is how many repos the shards are spread over, since a repo takes one push at a time. Returns them.", inputSchema: { type: "object", properties: { repo: str, required: { type: "number" }, vetoes: { type: "array", items: str }, escalate: { type: "array", items: { type: "object", properties: { paths: { type: "array", items: str }, required: { type: "number" }, vetoes: { type: "array", items: str } }, required: ["paths"] } }, grants: { type: "object", additionalProperties: { type: "array", items: str } }, verify: { type: "array", items: str }, shard_depth: { type: "number" }, records_repos: { type: "number" } }, required: ["repo"] } },
	{ name: "settings", description: "Change a started repo's review policy or its checks; whatever you leave out stays as it is. The same fields as start: required approvals, vetoes, escalate (stricter rules for chosen paths), grants (who may vote as each role), verify (the checks run before each merge; [] for none). Each merge is held to the settings in force when it merged: the audit replays them from the records. Returns the settings now. branch_rules sets other branches' settings by pattern (feature/*, release/*, a name), the first match winning: each changes only the policy fields and checks it names (verify [] for none; left out, the repo's); [] clears them. The project's branch always has the repo's settings.", inputSchema: { type: "object", properties: { repo: str, required: { type: "number" }, vetoes: { type: "array", items: str }, escalate: { type: "array", items: { type: "object", properties: { paths: { type: "array", items: str }, required: { type: "number" }, vetoes: { type: "array", items: str } }, required: ["paths"] } }, grants: { type: "object", additionalProperties: { type: "array", items: str } }, verify: { type: "array", items: str }, branch_rules: { type: "array", items: { type: "object", properties: { pattern: str, required: { type: "number" }, vetoes: { type: "array", items: str }, grants: { type: "object", additionalProperties: { type: "array", items: str } }, verify: { type: "array", items: str } }, required: ["pattern"] } } }, required: ["repo"] } },
	{ name: "credentials", description: "Git access. With your change: a write token for its own fork, where its branch changes/<change> lives. Without: read access to the project repo.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo"] } },
	{ name: "claims", description: "The claims in force: who holds which paths, and why.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "claim", description: "Claim paths for your change (again to extend it, or to keep it active). Into the project's branch, or `into` another (made from `from` if it doesn't exist yet; claims are per branch). `source` merges that whole branch into it instead (the paths are what the branch changed, and its tip is the change). `after` names changes it depends on: it merges only once they have merged into the same branch. Refused, naming the holder, if another claim on that branch overlaps; a claim in the way that its agent has abandoned (see release) is released as stale instead.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, paths: { type: "array", items: str }, intent: str, into: str, from: str, after: { type: "array", items: str }, source: str }, required: ["repo", "change", "agent", "intent"] } },
	{ name: "release", description: "Release a claim: yours, or with stale: true another agent's it has abandoned: its change waits on that agent, unanswered for 30 minutes with nothing pushed, or 2 hours after changes were asked for, a failed check in the merge line, or approval without a merge. Never one waiting for review, in the merge line, or on a person.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } }, required: ["repo", "change", "agent"] } },
	{ name: "next", description: "What you should do next, for any agent without a set role: merge your change if it's approved, revise it if a reviewer asked for changes, finish it if nothing is pushed; else review a change that's waiting (never your own, and a role that can block only if you hold it); else build a piece of the backlog nobody has taken; else wait. Says how to do it.", inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] } },
	{ name: "add_work", description: "Add a piece of work to the repo's backlog, for next to hand to an agent: a title, what it should do (intent), and the paths it's likely to touch. Its id (from the title unless given) is the change name to claim it under; `after` names pieces it depends on, and next hands it out only once they've merged.", inputSchema: { type: "object", properties: { repo: str, title: str, intent: str, paths: { type: "array", items: str }, after: { type: "array", items: str }, id: str, agent: str }, required: ["repo", "title", "intent", "agent"] } },
	{ name: "review_access", description: "Read access to a change you'll review: a read-only token for the author's fork, the change's branch (changes/<change>) and its pushed head, and read access to the project to diff against. Anyone may review; each grant is logged.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "vote", description: "Record your review verdict on the exact commit you reviewed.", inputSchema: { type: "object", properties: { repo: str, commit: str, reviewer: str, role: str, verdict: { type: "string", enum: ["approve", "reject"] }, evidence: str }, required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"] } },
	{ name: "merge", description: "Merge changes/<change> into the project's branch if the conventions hold, recording what was checked, then release the claim.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str }, required: ["repo", "change", "agent"] } },
	{ name: "build", description: "Have GitHive's hosted builder make a change: it claims the paths, builds on changes/<change>, asks the hosted reviewers when done, and the change merges once approved and checked.", inputSchema: { type: "object", properties: { repo: str, intent: str, paths: { type: "array", items: str } }, required: ["repo", "intent", "paths"] } },
	{ name: "request_review", description: "Ask GitHive's hosted reviewer agents to review your change's current commit (by default a general review, and every role that can veto it); each votes with vote.", inputSchema: { type: "object", properties: { repo: str, change: str, roles: { type: "array", items: str }, summary: str }, required: ["repo", "change"] } },
	{ name: "audit", description: "Replay the records and list every broken convention, with the commit and the agent (and whether a revert has resolved it).", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "revert", description: "Revert a commit the audit reports: its files go back to how they were before it, in a commit naming what it reverts.", inputSchema: { type: "object", properties: { repo: str, commit: str, agent: str }, required: ["repo", "commit", "agent"] } },
	{ name: "status", description: "Where a change stands: its claim (or how it ended), its branch head, the votes on that head with their evidence, the approvals still needed, and what GitHive's hosted agents on it are doing.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "check", description: "An early check on your change, any time before merging: whether it still merges cleanly into the project's branch, and any files outside your claim. (Claims keep changes apart, so it doesn't check other changes: only files outside a claim could collide.) Reports only.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "ask_human", description: "Ask a person to decide something about a change you can't settle among agents (reviewers disagree, a trade-off needs an owner). It waits in their inbox until a person votes on the change's commit.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str }, required: ["repo", "change", "agent", "reason"] } },
	{ name: "register", description: "Register your agent name and get its secret key (shown once), so what you write is attributed to you even if you share an Access identity. With your current key, rotates it.", inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] } },
];
// Every tool takes the caller's agent key, for clients that can't set the header.
export const TOOLS = annotate(
	TOOL_LIST.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, agent_key: { type: "string", description: "Your agent key from register, if you can't send the X-GitHive-Agent-Key header" } } } })),
	{
		start: writes("Start GitHive on a repo", { idempotent: true }),
		settings: writes("Change a repo's review policy or checks", { idempotent: true }),
		credentials: writes("Get Git access", { idempotent: true }),
		claims: reads("List claims"),
		review_access: reads("Get read access to a change to review"),
		next: reads("What to do next"),
		add_work: writes("Add work to the backlog"),
		claim: writes("Claim paths", { idempotent: true }),
		release: destroys("Release a claim", { idempotent: true }),
		vote: writes("Vote on a commit", { idempotent: true }),
		merge: writes("Merge a change"),
		build: writes("Build a change with GitHive's agent"),
		request_review: writes("Request review"),
		audit: reads("Audit the records"),
		revert: destroys("Revert a commit"),
		status: reads("Change status"),
		check: reads("Check a change"),
		register: destroys("Register an agent key"),
		ask_human: writes("Ask a person"),
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
		if (name !== acting) throw new Error(`[403] you act as ${acting}; you can't act as ${name}`);
		return;
	}
	if (hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) throw new Error("[403] githive- names are GitHive's hosted agents'");
	// "person:…", "service:…" name verified identities, which an agent can't take on.
	if (name.includes(":")) throw new Error("[403] an agent's name can't contain \":\"");
	// <handle>/<agent> names are signed-in agents', verified by their token.
	if (name.includes("/")) throw new Error(`[403] ${name} is a signed-in agent's name: sign in to GitHive as it to act as it`);
	if (registry?.agents?.[name]) throw new Error(`[403] ${name} is registered: call with its agent key`);
}

export type Args = Record<string, unknown>;

/** The claims in force and the changes merged: what advice (the claims tool, next) reads of the claims. */
export interface ClaimsAdvice {
	claims: ClaimRecord[];
	merged: string[];
}

/** A record's log: the context's shared one, or one for this call. */
function recordLog<S>(ctx: ToolContext, repo: string, ref: string): GitCasLog<S> {
	return ctx.records ? ctx.records<S>(repo, ref) : new GitCasLog<S>(() => ctx.remote(repo, "write"), repo, ref);
}

/** A repo's claims, where its registry says they are: in the registry itself, or split into per-path shards. */
/** The claims in force and the changes merged, read now from the records (see keptClaims). */
async function advice(ctx: ToolContext, repo: string): Promise<ClaimsAdvice> {
	const log = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const head = await log.read();
	const view = await storeFor(ctx, repo, head?.commit.state, { log, head }).read();
	const branch = projectBranch(head?.commit.state);
	return { claims: view.claims.map((c) => presentClaim(c, branch)), merged: view.released.filter((r) => r.mergedAs).map((r) => r.change) };
}

/** The arguments start and settings take for the review policy. */
const POLICY_FIELDS = ["required", "vetoes", "escalate", "grants"] as const;

/** A branch's review policy and checks: the repo's, with what a branch rule for it changes (see branch-rules.ts). */
export function branchSettings(registry: Registry | null | undefined, branch: string | undefined) {
	const project = projectBranch(registry);
	return settingsForBranch({ policy: registry?.policy ?? DEFAULT_POLICY, verify: registry?.verify ?? [], ...(registry?.branchRules ? { rules: registry.branchRules } : {}), project }, branch ?? project);
}

/**
 * Branch rules from settings' arguments: each a pattern, the policy fields it
 * changes (as start takes them) and its checks (verify; left out, the repo's).
 * An empty list clears them.
 */
function branchRulesFrom(value: unknown, base: ReviewPolicy): BranchRule<ReviewPolicy>[] {
	if (!Array.isArray(value)) throw new Error("[400] branch_rules is a list of rules: each a pattern, and what it changes");
	return value.map((raw, i) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`[400] branch_rules[${i}] is a rule: a pattern, and what it changes`);
		const rule = raw as Args;
		const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
		if (!pattern || !BRANCH_PATTERN.test(pattern)) throw new Error(`[400] branch_rules[${i}].pattern is a branch name, with * for any run of characters (feature/*)`);
		// Only the fields it sets: the rest stay the repo's, as the repo's change.
		const full = policyFrom(rule, base);
		const policy = Object.fromEntries(POLICY_FIELDS.filter((f) => rule[f] !== undefined).map((f) => [f, full[f]])) as Partial<ReviewPolicy>;
		const verify = rule.verify === undefined ? undefined : checksFrom(rule.verify);
		if (!Object.keys(policy).length && !verify) throw new Error(`[400] branch_rules[${i}] (${pattern}) changes nothing: set required, vetoes, escalate, grants or verify`);
		return { pattern, ...(Object.keys(policy).length ? { policy } : {}), ...(verify ? { verify } : {}) };
	});
}

/** A review policy from start's or settings' arguments, each one left out kept from `base`. */
function policyFrom(args: Args, base: ReviewPolicy): ReviewPolicy {
	const required = typeof args.required === "number" ? args.required : base.required;
	if (!Number.isInteger(required) || required < 0) throw new Error("[400] required is a whole number of approvals, 0 for none");
	const grants = args.grants !== undefined ? validGrants(args.grants) : base.grants;
	return {
		required,
		vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : base.vetoes,
		// The base's escalation unless the caller sets its own (an empty list for none).
		escalate: Array.isArray(args.escalate) ? (args.escalate as ReviewPolicy["escalate"]) : base.escalate,
		// No grants: every role keeps the default holders.
		...(grants && Object.keys(grants).length ? { grants } : {}),
	};
}

/** The checks run before each merge, as start and settings take them. */
function checksFrom(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("[400] verify is a list of commands, [] for none");
	return value.filter((c): c is string => typeof c === "string" && !!c.trim());
}

/** Role grants as start takes them: each role to a list of agent names, "person:*", verified identities, teams (@<org>/<team>) or "githive". */
function validGrants(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[400] grants maps each role to who may vote as it");
	const grants: Record<string, string[]> = {};
	for (const [role, who] of Object.entries(value)) {
		if (!Array.isArray(who) || !who.every((w) => typeof w === "string" && w.trim())) throw new Error(`[400] grants.${role} is a list: agent names, "person:*", "person:<who>", "service:<id>", a team "@<org>/<team>" or "githive"`);
		grants[role] = who.map((w) => w.trim());
	}
	return grants;
}

/**
 * Tell people (their inbox) about each review a role that can block has
 * awaited, unheld, for ROLE_WAIT_MS: once per commit and role. Never
 * GitHive's own reviewers: if no person holds the role, the flag says so,
 * so its holders can be nudged or more granted.
 */
async function tellPeopleOfWaitingRoles(ctx: ToolContext, repo: string, votes: VoteStore, policy: ReviewPolicy, open: { claim: ClaimRecord; head: string | null }[], counted: VoteRecord[], policyOf?: (claim: ClaimRecord) => ReviewPolicy) {
	if (!ctx.reviews?.waits || !ctx.reviews.told) return;
	const waiting = waitingRoleReviews({ policy, ...(policyOf ? { policyOf } : {}), open, votes: counted, held: await ctx.reviews.held(repo) });
	const seen = await ctx.reviews.waits(repo, waiting.map((w) => holdKey(w.head, w.role)));
	let told = false;
	for (const w of waiting) {
		const key = holdKey(w.head, w.role);
		const since = seen[key];
		if (!since || since.told || Date.now() - since.since < ROLE_WAIT_MS) continue;
		const holders = policy.grants?.[w.role] ?? DEFAULT_GRANT;
		const people = holders.some((h) => h.startsWith("person:"));
		const minutes = Math.round((Date.now() - since.since) / 60_000);
		const reason = `${w.change}'s ${w.role} review has waited ${minutes} minutes and none of its holders (${holders.join(", ")}) has taken it. ${people ? `You can review it as ${w.role} from the dashboard.` : `No person holds ${w.role}, so you can't sign it off: nudge its holders, or grant it to more.`}`;
		await votes.flag({ change: w.change, agent: "githive", role: w.role, reason });
		await ctx.reviews.told(repo, key);
		told = true;
	}
	if (told) {
		await ctx.ping?.(repo).catch(() => undefined);
		await repoSnapshot(ctx, repo).catch(() => undefined);
	}
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
async function shardIfBusy(ctx: ToolContext, repo: string, log: GitCasLog<Registry>, registry: Registry | null | undefined, agent: string) {
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
export function votesFor(ctx: ToolContext, repo: string, rootHead?: Awaited<ReturnType<GitCasLog<Votes>["read"]>>): VoteStore {
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
async function shardVotesIfBusy(ctx: ToolContext, repo: string, registry: Registry | null | undefined, reviewer: string) {
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

export function storeFor(ctx: ToolContext, repo: string, registry: Registry | null | undefined, root?: { log: GitCasLog<Registry>; head: Awaited<ReturnType<GitCasLog<Registry>["read"]>> }): ClaimStore {
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
function changeSourceFor(ctx: ToolContext, repo: string) {
	return async (agent: string, scope: "read" | "write", change?: string): Promise<Remote> => {
		if (!ctx.changeRemote) throw new Error("[501] change forks aren't available here");
		if (scope === "write" || !change || !ctx.legacyChangeRemote) return ctx.changeRemote(repo, agent, scope);
		const fork = await ctx.changeRemote(repo, agent, "read").catch(() => null);
		if (fork && (await branchHead(fork, `changes/${change}`).catch(() => null))) return fork;
		return (await ctx.legacyChangeRemote(repo, change).catch(() => null)) ?? fork ?? ctx.changeRemote(repo, agent, "read");
	};
}

/** Where a change stands: its branch head, the votes on that head, the approvals against the policy, and GitHive's hosted agents on it. */
async function changeStatus(ctx: ToolContext, repo: string, registry: Registry | null | undefined, votesOn: (head: string) => Promise<VoteRecord[]>, change: string, author: ClaimRecord | undefined, agent = author?.agent) {
	// No fork (or no branch on it) means nothing pushed yet.
	const head = await Promise.resolve()
		.then(() => changeSourceFor(ctx, repo)(agent ?? fail(409, `${change} has no agent`), "read", change))
		.then((source) => branchHead(source, `changes/${change}`))
		.catch(() => null);
	// The policy for the paths it claims: stricter for dependency, CI and deploy files, say.
	const paths = author?.paths ?? [];
	// The branch it lands on decides the policy too (see branch-rules.ts).
	const policy = branchSettings(registry, author?.into).policy;
	const { required, vetoes } = effectivePolicy(policy, paths);
	const cast = head ? (await votesOn(head)).filter((v) => v.commit === head) : [];
	const outcome = head ? approval({ votes: await countedVotes(cast, registry?.stampKey) }, head, policy, author, paths) : { approved: false, approvals: 0, vetoedBy: [], awaiting: vetoes };
	const hosted = ctx.agentStatus ? await ctx.agentStatus(repo, change, head, hostedRoles(vetoes)).catch(() => undefined) : undefined;
	return { head, votes: cast, approval: { ...outcome, required }, ...(hosted ? { hosted } : {}) };
}

/** How a line's leaving hands a change back to its agent (see staleness.ts): it didn't land and its agent has to act. */
const LEFT_TO_AGENT = new Set(["failed", "gave up", "went quiet"]);

/**
 * What's known of a change for whose turn it is: its head, the votes on it
 * that count (`counted`, stamps already checked), a question waiting
 * (`record`: the votes record, for its flags), and the line.
 */
export function changeSigns(input: { claim: ClaimRecord; head: string | null; counted: VoteRecord[]; record: Pick<Votes, "votes" | "flags">; line?: Line | null; policy: ReviewPolicy }): ChangeSigns {
	const { claim, head } = input;
	const counted = head ? input.counted.filter((v) => v.commit === head && v.reviewer !== claim.agent) : [];
	const outcome = head ? approval({ votes: counted }, head, input.policy, { agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) }, claim.paths) : undefined;
	const left = head ? input.line?.left.filter((l) => l.change === claim.change && l.head === head && LEFT_TO_AGENT.has(l.how)).at(-1) : undefined;
	return {
		active: claim.active,
		head,
		votes: counted.map((v) => ({ verdict: v.verdict, at: v.at })),
		approved: !!outcome?.approved,
		vetoed: !!outcome?.vetoedBy.length,
		inLine: !!input.line?.entries.some((e) => e.change === claim.change),
		asked: !!openFlag(input.record, claim.change, head),
		...(left ? { leftLineAt: left.at } : {}),
	};
}

/**
 * Whether a claim is abandoned on its agent's own turn, as the toolkit decides
 * it when a claim is in the way or asked to be released as stale: its head as
 * its fork has it now, the votes on it, and the line, read fresh (a release
 * can't be undone).
 */
function abandonedRule(ctx: ToolContext, repo: string, registered: Registry | null | undefined, votes: VoteStore): Abandoned {
	let line: Promise<Line | null> | undefined;
	return async (claim) => {
		line ??= (async () => {
			const log = recordLog<Line>(ctx, repo, lineRef(repo));
			return ((await (log.readFresh?.() ?? log.read()))?.commit.state ?? null) as Line | null;
		})().catch(() => null);
		const head = await changeSourceFor(ctx, repo)(claim.agent, "read", claim.change)
			.then((fork) => branchHead(fork, `changes/${claim.change}`))
			.catch(() => null);
		const view = await votes.readFor(head ? [head] : []);
		const counted = head ? await countedVotes(view.votes.filter((v) => v.commit === head), registered?.stampKey) : [];
		const shown = presentClaim(claim, projectBranch(registered));
		const signs = changeSigns({ claim: shown, head, counted, record: view, line: await line, policy: branchSettings(registered, shown.into).policy });
		const outcome = abandoned(signs, Date.now());
		return { abandoned: outcome.abandoned, why: outcome.waiting.why };
	};
}

/**
 * A change that merges branch `source` into `into` whole: the files `source`
 * changed since it left `into`, as a claim (folders, when there are many: see
 * claimCovering), and its tip, which the change pushes to its agent's fork as
 * its branch, so review, check, the line and merge treat it as any change.
 */
async function branchMerge(ctx: ToolContext, repo: string, source: string, into: string) {
	if (source === into) throw new Error(`[400] a change can't merge ${into} into itself`);
	const project = await ctx.remote(repo, "read");
	const ws = await Workspace.clone(project, into).catch(() => fail(409, `there's no branch ${into}`));
	const tip = await ws.fetch("source", project, source).catch(() => fail(409, `there's no branch ${source}`));
	const files = await ws.changedPaths(await ws.mergeBase(await ws.head(), tip), tip);
	if (!files.length) throw new Error(`[409] ${source} has nothing ${into} doesn't have`);
	const paths = claimCovering(files) ?? fail(409, `${source} changes too much of ${into} to claim at once: merge it in parts`);
	return {
		tip,
		paths,
		/** Push the tip to the fork as changes/<change>: from this shallow workspace, or with the source's whole history if the fork lacks what it leaves out. */
		push: async (fork: Remote, change: string) => {
			const to = `refs/heads/changes/${change}`;
			await ws.pushAs(`refs/remotes/source/${source}`, to, fork).catch(async () => (await Workspace.clone(project, source, { depth: 1 << 20 })).pushAs(`refs/heads/${source}`, to, fork));
		},
	};
}

/** A list of change ids from an argument (none when it's absent). */
function changeList(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v))) throw new Error(`[400] ${field} is a list of change ids`);
	return [...new Set(value as string[])];
}

/**
 * A loop `change` would close by waiting on `after`: the changes from it back
 * to itself, or none. Follows what each change waits on (as far as 50 changes).
 */
async function dependencyLoop(change: string, after: string[], afterOf: (change: string) => Promise<string[]>): Promise<string[] | undefined> {
	const paths: string[][] = after.map((dep) => [change, dep]);
	const seen = new Set<string>();
	while (paths.length && seen.size < 50) {
		const path = paths.shift()!;
		const last = path.at(-1)!;
		if (last === change) return path;
		if (seen.has(last)) continue;
		seen.add(last);
		for (const next of await afterOf(last)) paths.push([...path, next]);
	}
	return undefined;
}

/** A branch name changes may land on: letters, digits, dots, dashes, underscores and slashes, as Git allows them. */
const BRANCH_NAME = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]+$/;

/**
 * Make sure a branch other than the project's can take changes: recorded
 * already; or there, so adopted as it is now; or made from `from` (a missing
 * branch is never made without one, so a misspelt name is refused, not made).
 * Made first, then recorded: a record that fails is made good by adopting the
 * branch on the next claim. Says what it did, if anything.
 */
async function targetBranch(ctx: ToolContext, repo: string, input: { into: string; from?: string; registered: Registry | null | undefined; claims: GitCasLog<Registry>; agent: string; stamper?: Stamper }): Promise<string | undefined> {
	const { into, from, registered, claims, agent, stamper } = input;
	if (!BRANCH_NAME.test(into)) throw new Error(`[400] ${into} isn't a branch name changes can land on`);
	if (registered?.branches?.[into]) return undefined;
	const found = await branchHead(await ctx.remote(repo, "read"), into);
	if (found) {
		await recordBranch(claims, { name: into, base: found, agent }, stamper);
		return `changes land on ${into} from now on, as it is at ${found.slice(0, 8)}`;
	}
	if (!from) throw new Error(`[409] ${into} doesn't exist: claim again with from (the branch to make it from, ${projectBranch(registered)} say)`);
	const ws = await Workspace.clone(await ctx.remote(repo, "write"), from, { depth: 1 }).catch(() => fail(409, `can't make ${into} from ${from}: there's no branch ${from}`));
	await ws.pushNewBranch(into);
	const base = await ws.head();
	await recordBranch(claims, { name: into, base, from, agent }, stamper);
	return `made ${into} from ${from} at ${base.slice(0, 8)}`;
}

/** Replay a repo's records from Git: how many commits on the project's branch since GitHive started on it, and what broke which convention. */
async function runAudit(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const remote = await t.time("token", () => ctx.remote(repo, "read"));
	// The votes don't depend on the registry: read them meanwhile.
	const votesRead = t.time("votes", () => readRecordHistory<Votes>(remote, votesRef(repo)));
	votesRead.catch(() => undefined);
	const registry = await t.time("registry", () => readRecordHistory<Registry>(remote, claimsRef(repo)));
	const baseline = registry[0]?.state.baseline;
	if (!baseline) throw new Error(`[409] GitHive hasn't started on ${repo}`);
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
	// The other branches changes land on, each read after the commit it started at, its files named as their claims are.
	const project = projectBranch(start);
	const onBranches = (
		await t.time("branches", () =>
			Promise.all(
				Object.entries(latest.branches ?? {}).map(async ([name, record]) =>
					(await readMainMerges(remote, record.base, name)).map((m) => ({ ...m, branch: name, claimFiles: m.files.map((f) => scopeFile(f, name, project)) })),
				),
			),
		)
	).flat();
	const all = [...merges, ...onBranches];
	const violations = await t.time("audit", () => audit({ registry, ...(shards ? { shards } : {}), votes: votesHistory, ...(voteBuckets ? { voteBuckets } : {}), policy: start.policy ?? DEFAULT_POLICY, verify: start.verify, merges: all }));
	return { merges: all.length, violations };
}

/** The audit of a repo, for the dashboard: it replays every record, so it's read apart from the snapshot. */
/**
 * One change's history, for its page on the dashboard: its claim (or how it
 * ended), the commits on its branch (the last 50, newest first), every vote on
 * any of them, and the merge if it merged.
 */
export async function changeHistory(ctx: ToolContext, repo: string, change: string) {
	const t = ctx.timing ?? new Timing();
	const registry = (await t.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit.state;
	if (!registry?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await t.time("change", () => storeFor(ctx, repo, registry).readChange(change));
	if (!record && !released.length) throw new Error(`[404] no change ${change} on ${repo}`);
	// The branch the change lands on: its own commits are those since it left that one.
	const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
	const claim = record ? presentClaim(record, projectBranch(registry)) : undefined;
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
export async function voteAsPerson(ctx: ToolContext, repo: string, change: string, input: { role: string; verdict: "approve" | "reject"; evidence: string }, person: string) {
	if (!person.startsWith("person:")) throw new Error("[403] only a person signed in through Access votes from the dashboard; agents use vote");
	if (!input.role?.trim()) throw new Error("[400] a vote needs a role");
	if (input.verdict !== "approve" && input.verdict !== "reject") throw new Error("[400] verdict is approve or reject");
	if (typeof input.evidence !== "string" || !input.evidence.trim()) throw new Error("[400] a vote needs evidence: what you checked");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to vote on`);
	const head = await branchHead(await changeSourceFor(ctx, repo)(claim.agent, "read", change), `changes/${change}`).catch(() => null);
	if (!head) throw new Error(`[409] ${change} has nothing pushed to vote on`);
	const stamper = await ctx.stamper?.();
	const teams = (await ctx.teamsOf?.(repo)) ?? [];
	await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registry, person)).vote({ commit: head, reviewer: person, role: input.role, verdict: input.verdict, evidence: input.evidence, ...(teams.length ? { teams } : {}) }, stamper);
	await ctx.ping?.(repo).catch(() => undefined);
	return { commit: head, role: input.role, verdict: input.verdict };
}

/**
 * A branch made (or adopted) by a person from the dashboard: what a claim
 * with into and from does, without the claim. Recorded with the person's name.
 */
export async function makeBranch(ctx: ToolContext, repo: string, input: { name: string; from: string }, person: string) {
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const registered = (await claims.read())?.commit.state;
	if (!registered?.baseline) throw new Error(`[409] GitHive hasn't started on ${repo}`);
	if (input.name === projectBranch(registered) || registered.branches?.[input.name]) throw new Error(`[409] ${input.name} takes changes already`);
	const made = await targetBranch(ctx, repo, { into: input.name, from: input.from, registered, claims, agent: person, ...(ctx.stamper ? { stamper: await ctx.stamper() } : {}) });
	await ctx.ping?.(repo).catch(() => undefined);
	return { name: input.name, made };
}

/**
 * A person merging a change from the dashboard: the same merge an agent asks
 * for (through the branch's line, with its checks), as the change's agent,
 * stamped with the person who asked.
 */
export async function mergeAsPerson(ctx: ToolContext, repo: string, change: string, person: string) {
	if (!person.startsWith("person:")) throw new Error("[403] only a person merges from the dashboard; agents use merge");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to merge`);
	const outcome = await callTool("merge", { repo, change, agent: claim.agent }, ctx);
	await ctx.ping?.(repo).catch(() => undefined);
	return outcome;
}

/** The roles GitHive's own reviewers take on a change: one general review, and every role that can veto. */
export const hostedRoles = (vetoes: string[]) => [...new Set(["review", ...vetoes])];

export async function repoAudit(ctx: ToolContext, repo: string) {
	const { merges, violations } = await runAudit(ctx, repo);
	const open = violations.filter((v) => !v.resolvedBy).length;
	await ctx.summarize?.(repo, { merged: merges, violations: open }).catch(() => undefined);
	return { merges, open, violations };
}

/** What the dashboard shows for a repo, read from the records' tips (the audit is apart, in repoAudit). */
export async function repoSnapshot(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const [registry, votes] = await t.time("records", () => Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), votesFor(ctx, repo).read()]));
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const held = await t.time("claims", () => storeFor(ctx, repo, state).read());
	const claims = await t.time("status", () => Promise.all(
		held.claims.map(async (record) => {
			const c = presentClaim(record, projectBranch(state));
			const { head, approval, hosted } = await changeStatus(ctx, repo, state, async () => votes.votes, c.change, c);
			// A question for a person, until a person votes on the change's commit (or, for a waiting role's review, until the role signs it off).
			const asked = openFlag(votes, c.change, head);
			const flag = asked?.role && !approval.awaiting?.includes(asked.role) ? null : asked;
			const attention = flag ? { reason: flag.reason, agent: flag.agent, at: flag.at } : hosted?.builder?.status === "failed" ? { reason: `GitHive's builder failed${hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : ""}`, agent: "githive-builder", at: c.active } : null;
			// What it waits on (after) that hasn't merged into the branch it lands on yet.
			const into = c.into ?? projectBranch(state);
			const waitsOn = (c.after ?? []).filter((dep) => !held.released.some((r) => r.change === dep && r.mergedAs && (r.into ?? projectBranch(state)) === into));
			return { ...c, head, approval, ...(hosted ? { hosted } : {}), ...(attention ? { attention } : {}), ...(waitsOn.length ? { waitsOn } : {}) };
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
		/** Other branches' settings by pattern (see branch-rules.ts). */
		...(state.branchRules?.length ? { branchRules: state.branchRules } : {}),
		/** The other branches changes land on: where each started. */
		branches: Object.entries(state.branches ?? {}).map(([name, b]) => ({ name, base: b.base, ...(b.from ? { from: b.from } : {}), at: b.at })),
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
const WRITES = new Set(["claim", "release", "merge", "vote", "build", "revert", "ask_human", "check", "add_work", "settings"]);
const noted = new Map<string, number>();

/** Run one tool, and note what it wrote in the repo's summary. */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const result = await runTool(name, args, ctx);
	if (WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false) await ctx.ping?.(requiredString(args, "repo")).catch(() => undefined);
	if (ctx.summarize && WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false) {
		const repo = requiredString(args, "repo");
		const merged = name === "merge";
		// Activity alone is noted at most every 10 seconds per repo, so a busy repo doesn't queue on the index.
		if (merged || Date.now() - (noted.get(repo) ?? 0) > 10_000) {
			noted.set(repo, Date.now());
			await ctx.summarize(repo, { lastActivity: new Date().toISOString(), ...(merged ? { mergedBy: 1 } : {}) }).catch((err) => console.error(`summarizing ${repo} failed`, String(err)));
		}
		// A question for a person belongs in their inbox now, not when someone next opens the repo: the snapshot updates the summary's waiting list.
		if (name === "ask_human") await repoSnapshot(ctx, repo).catch((err) => console.error(`updating ${repo}'s inbox failed`, String(err)));
	}
	return result;
}

/** How many claims are in force on a repo, read from its records alone: the repo list's count. Null before GitHive starts on it. */
export async function openCount(ctx: ToolContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}

async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	// The claims tool is advice: from the kept copy when the context keeps one, without reading the registry
	// first (on a busy repo, every call reading the project repo is what overloads it).
	if (name === "claims" && ctx.keptClaims) return (await ctx.keptClaims(repo, () => advice(ctx, repo))).claims;
	const write = () => ctx.remote(repo, "write");
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const votes = votesFor(ctx, repo);
	// Read once per call; only start, which writes it first, reads it again.
	const rootHead = await claims.read();
	const registered = rootHead?.commit.state;
	const key = ctx.agentKey ?? (typeof args.agent_key === "string" ? args.agent_key : undefined);
	// A signed-in agent is who its token says; otherwise an agent key names the agent.
	const acting = ctx.agent ?? (key ? await keyAgent(registered, key) : undefined);
	/** The agent named in `field`; a signed-in agent may leave it out. */
	const agentArg = (field: string) => (ctx.agent && !(typeof args[field] === "string" && args[field].trim()) ? ctx.agent : requiredString(args, field));
	const actAs = (field: string) => {
		const agent = agentArg(field);
		mayActAs(agent, acting, registered, ctx.hosted);
		return agent;
	};
	const stamper = await ctx.stamper?.(acting);
	const store = storeFor(ctx, repo, registered, { log: claims, head: rootHead });
	/** The project's branch: changes land on it unless their claim says `into` another (see branch-scope.ts). */
	const branch = projectBranch(registered);
	/** A claim as agents see it: its own paths, and the branch it lands on when not the project's. */
	const present = <C extends ClaimRecord>(c: C) => presentClaim(c, branch);
	let viewing: ReturnType<ClaimStore["read"]> | undefined;
	/** The claims in force, read at most once per call. */
	const view = () => (viewing ??= store.read().then((v) => ({ ...v, claims: v.claims.map(present) })));
	/** The claims for advice: the kept copy when the context keeps one (see keptClaims), else read now. */
	const adviceView = async (): Promise<ClaimsAdvice> => {
		const read = async () => {
			const v = await view();
			return { claims: v.claims, merged: v.released.filter((r) => r.mergedAs).map((r) => r.change) };
		};
		return ctx.keptClaims ? ctx.keptClaims(repo, read) : read();
	};
	const changes = new Map<string, ReturnType<ClaimStore["readChange"]>>();
	/** One change's claim and releases, read at most once per call, and only from what holds them. */
	const changeOf = (change: string) => {
		if (!changes.has(change)) changes.set(change, store.readChange(change).then((c) => (c.claim ? { ...c, claim: present(c.claim) } : c)));
		return changes.get(change)!;
	};
	const claimOf = async (change: string) => (await changeOf(change)).claim;
	/** What of `after` hasn't merged into `into` yet, each in words (none: nothing to wait for). */
	const waitingOn = async (after: string[], into: string) =>
		(
			await Promise.all(
				after.map(async (dep) => {
					const merged = (await changeOf(dep)).released.filter((r) => r.mergedAs).at(-1);
					if (!merged) return `waits on ${dep}, which hasn't merged yet`;
					const landed = merged.into ?? branch;
					return landed === into ? null : `waits on ${dep}, which merged into ${landed}, not ${into}`;
				}),
			)
		).filter((w): w is string => !!w);
	const changeSource = changeSourceFor(ctx, repo);
	/** Warm the check container for a merge to come (only where the repo has checks): why, and for which change or commit. */
	const warmChecks = async (expect: "checked" | "approved", key: string) => {
		if (registered?.verify?.length) await ctx.warmChecks?.(repo, { branch: projectBranch(registered), checks: registered.verify, expect, key }).catch(() => undefined);
	};
	switch (name) {
		case "start": {
			const policy = policyFrom(args, DEFAULT_POLICY);
			const verify = args.verify === undefined ? [] : checksFrom(args.verify);
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
			await startRepo(claims, { baseline: await ctx.head(repo, branch), branch, policy, verify, stampKey: stamper?.publicKey, ...sharding });
			await ctx.register?.(repo);
			const registry = (await claims.read())?.commit.state;
			// The check containers warm up while agents start: the first merge is minutes away, and a fresh install takes them.
			if (registry?.verify?.length) await ctx.warmChecks?.(repo, { branch: projectBranch(registry), checks: registry.verify, expect: "set up" }).catch(() => undefined);
			const warnings = grantWarnings(registry?.policy ?? policy);
			return { repo, branch: projectBranch(registry), policy: registry?.policy ?? policy, verify: registry?.verify ?? [], ...shardingOf(registry), ...(warnings.length ? { warnings } : {}), instructions: INSTRUCTIONS };
		}
		case "settings": {
			if (!registered?.baseline) throw new Error(`[409] GitHive hasn't started on ${repo}: start it first`);
			const policy = POLICY_FIELDS.some((f) => args[f] !== undefined) ? policyFrom(args, registered.policy ?? DEFAULT_POLICY) : undefined;
			const verify = args.verify === undefined ? undefined : checksFrom(args.verify);
			const branchRules = args.branch_rules === undefined ? undefined : branchRulesFrom(args.branch_rules, registered.policy ?? DEFAULT_POLICY);
			if (!policy && !verify && !branchRules) throw new Error(`[400] name what to change: ${[...POLICY_FIELDS, "verify", "branch_rules"].join(", ")}`);
			await changeSettings(claims, { ...(policy ? { policy } : {}), ...(verify ? { verify } : {}), ...(branchRules ? { branchRules } : {}), ...(stamper?.by ? { by: stamper.by } : {}) });
			const registry = (await claims.read())?.commit.state;
			// New checks may install something new: warm the containers for them.
			if (verify?.length) await ctx.warmChecks?.(repo, { branch: projectBranch(registry), checks: verify, expect: "set up" }).catch(() => undefined);
			const warnings = grantWarnings(registry?.policy ?? DEFAULT_POLICY);
			return { repo, branch: projectBranch(registry), policy: registry?.policy ?? DEFAULT_POLICY, verify: registry?.verify ?? [], ...(registry?.branchRules?.length ? { branchRules: registry.branchRules } : {}), ...(warnings.length ? { warnings } : {}) };
		}
		case "next": {
			const agent = actAs("agent");
			const [inForce, cast, backlog, line] = await Promise.all([
				adviceView(),
				votes.read(),
				recordLog<Work>(ctx, repo, workRef(repo)).read(),
				// For whose turn each change is (kept a moment: next only advises, and the claim decides).
				recordLog<Line>(ctx, repo, lineRef(repo)).read().then((l) => l?.commit.state ?? null).catch(() => null),
			]);
			// Each open change's pushed head, from its author's fork: the caller's own now, the others' as kept a few
			// seconds (one request per open change, which a crowd asking next would otherwise make on every call).
			const headOf = (claim: ClaimRecord) => changeSource(claim.agent, "read", claim.change).then((fork) => branchHead(fork, `changes/${claim.change}`)).catch(() => null);
			const others = inForce.claims.filter((c) => c.agent !== agent);
			const kept = ctx.keptHeads && others.length ? await ctx.keptHeads(repo, async () => Object.fromEntries(await Promise.all(inForce.claims.map(async (c) => [c.change, await headOf(c)])))).catch(() => undefined) : undefined;
			const open = await Promise.all(inForce.claims.map(async (claim) => ({ claim, head: claim.agent === agent || !kept ? await headOf(claim) : (kept[claim.change] ?? null) })));
			const counted = await countedVotes(cast.votes, registered?.stampKey);
			const teams = (await ctx.teamsOf?.(repo)) ?? [];
			const decide = (held?: Record<string, string[]>) => nextFor({
				agent,
				...(stamper?.by ? { by: stamper.by } : {}),
				...(teams.length ? { teams } : {}),
				policy: registered?.policy ?? DEFAULT_POLICY,
				// Each change's by the branch it lands on.
				policyOf: (claim: ClaimRecord) => branchSettings(registered, claim.into).policy,
				open,
				votes: counted,
				merged: new Set(inForce.merged),
				// Its own changes waiting on a person: asked about, not yet answered on their head (not a review GitHive flagged as waiting).
				asked: new Set(open.filter((o) => o.claim.agent === agent && openFlag(cast, o.claim.change, o.head) && !openFlag(cast, o.claim.change, o.head)?.role).map((o) => o.claim.change)),
				work: backlog?.commit.state.items ?? [],
				...(held ? { held } : {}),
				crowd: Math.max(Object.keys(registered?.agents ?? {}).length, new Set(inForce.claims.map((c) => c.agent)).size),
				abandoned: new Set(open.filter((o) => abandoned(changeSigns({ claim: o.claim, head: o.head, counted, record: cast, line, policy: branchSettings(registered, o.claim.into).policy }), Date.now()).abandoned).map((o) => o.claim.change)),
			});
			// A review is held for this agent before it's handed out, so two agents aren't sent to one that needs one review.
			if (!ctx.reviews) return decide();
			// Reviews a role that can block has waited too long for: people hear of it (whoever asks next notices; no timer).
			await tellPeopleOfWaitingRoles(ctx, repo, votes, registered?.policy ?? DEFAULT_POLICY, open, counted, (claim) => branchSettings(registered, claim.into).policy).catch((err) => console.error(`checking ${repo}'s waiting reviews failed`, String(err)));
			for (let attempt = 0; attempt < 3; attempt++) {
				const next = decide(await ctx.reviews.held(repo).catch(() => ({})));
				// A hold that couldn't be written isn't taken: handing the review out anyway sent a crowd to one review.
				if (next.kind !== "review" || (await ctx.reviews.hold(repo, holdKey(next.head, next.role), agent, next.needed).catch(() => false))) return next;
			}
			// Others kept taking the reviews first: they're covered.
			return { kind: "wait", reason: "other agents just took the reviews that were waiting", retryAfterSeconds: 15, next: "Call next again in a little while." } satisfies NextStep;
		}
		case "add_work": {
			const title = requiredString(args, "title");
			const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : workId(title);
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("[400] a work id is letters, digits, dots, dashes and underscores");
			const paths = args.paths === undefined ? undefined : normalizeClaim(requiredPaths(args, "paths"));
			const after = changeList(args.after, "after");
			const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), { id, title, intent: requiredString(args, "intent"), ...(paths ? { paths } : {}), ...(after.length ? { after } : {}), by: actAs("agent") });
			return added.ok ? { ok: true, id } : { ok: false, reason: added.refused };
		}
		case "review_access": {
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
			const into = (await claimOf(change))?.into ?? branch;
			return { change, author, url: fork.url, token: fork.token, branch: `changes/${change}`, head, project: { url: project.url, token: project.token, branch: into }, ...(into !== branch ? { into } : {}) };
		}
		case "credentials": {
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
			// The branch the change lands on: the project's, or the one its claim names.
			const into = own.into ?? branch;
			return {
				url: remote.url,
				token: remote.token,
				branch: `changes/${change}`,
				project: { url: project.url, token: project.token, branch: into },
				...(into !== branch ? { into } : {}),
				note: `Your own fork, for all your changes: push this change's branch changes/${change} to it. Start the branch from the project's ${into} (project), not the fork's, which may be behind${into !== branch ? `: this change lands on ${into}, not ${branch}` : ""}.`,
			};
		}
		case "claims":
			return (await adviceView()).claims;
		case "claim": {
			const change = requiredString(args, "change");
			const agent = actAs("agent");
			// A whole branch merged into the one the change lands on: its tip is the change, its diff the claim (see branchMerge).
			const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
			const given = source ? [] : normalizeClaim(requiredPaths(args, "paths"));
			const reserved = given.find(isReservedPath);
			if (reserved) throw new Error(`[400] ${reserved}: a path can't start with "::"`);
			// A change lands on one branch: claiming again keeps it there, and naming another is refused.
			const held = await claimOf(change);
			const asked = typeof args.into === "string" && args.into.trim() ? args.into.trim() : undefined;
			const into = asked ?? held?.into ?? branch;
			if (held && (held.into ?? branch) !== into) throw new Error(`[409] ${change} lands on ${held.into ?? branch}: a change lands on one branch; claim another change for ${into}`);
			const made = into === branch || held ? undefined : await targetBranch(ctx, repo, { into, from: typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined, registered, claims, agent, stamper });
			const merging = source ? await branchMerge(ctx, repo, source, into) : undefined;
			const paths = merging ? merging.paths : given;
			const after = changeList(args.after, "after");
			if (after.includes(change)) throw new Error(`[400] ${change} can't wait on itself`);
			// A loop would leave every change in it waiting forever: refused.
			const loop = after.length ? await dependencyLoop(change, after, async (dep) => (await claimOf(dep))?.after ?? []) : undefined;
			if (loop) throw new Error(`[409] after ${loop.at(1)}, ${change} would wait on itself: ${loop.join(" waits on ")}`);
			const input = { change, agent, paths: scopePaths(paths, into, branch), intent: requiredString(args, "intent"), ...(after.length ? { after } : {}), ...(source ? { source } : {}), staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) };
			// Busy enough that one record would hold agents up: shard first, then claim in the shards.
			const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
			const outcome = await (sharded ? storeFor(ctx, repo, sharded) : store).claim(input, stamper);
			// Conflicts name paths as agents gave them; a claim into another branch says so.
			const conflicts = outcome.ok ? undefined : outcome.conflicts.map((c) => ({ ...c, path: presentClaim({ paths: [c.path] }, branch).paths[0], held: presentClaim({ paths: [c.held] }, branch).paths[0] }));
			// Claimed: the source's tip becomes the change's branch in the agent's fork, for review, check and merge like any change.
			if (outcome.ok && merging) await merging.push(await changeSource(agent, "write"), change);
			const merged = merging
				? { source, head: merging.tip, claimed: paths, note: `${change} merges ${source} at ${merging.tip.slice(0, 8)} into ${into}: its branch changes/${change} is that commit, in your fork. Get it reviewed, check and merge it like any change. If ${source} moves on, claim again to bring the change up to its new tip (a new head, so a new review).` }
				: {};
			return { ...outcome, ...(conflicts ? { conflicts } : {}), ...(into !== branch ? { into } : {}), ...(made ? { branch: made } : {}), ...merged };
		}
		case "release": {
			const change = requiredString(args, "change");
			const agent = actAs("agent");
			if (args.stale === true) return store.releaseStale({ change, agent, staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) }, stamper);
			return store.release({ change, agent, reason: typeof args.reason === "string" ? args.reason : "released" }, stamper);
		}
		case "ask_human": {
			const change = requiredString(args, "change");
			if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim`);
			return votes.flag({ change, agent: actAs("agent"), reason: requiredString(args, "reason") }, stamper);
		}
		case "vote": {
			const verdict = requiredString(args, "verdict");
			if (verdict !== "approve" && verdict !== "reject") throw new Error("[400] verdict is approve or reject");
			const reviewer = actAs("reviewer");
			// Busy enough that one record would hold reviewers up: shard the votes first.
			const commit = requiredString(args, "commit");
			const teams = (await ctx.teamsOf?.(repo)) ?? [];
			const cast = await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote({ commit, reviewer, role: requiredString(args, "role"), verdict, evidence: requiredString(args, "evidence"), ...(teams.length ? { teams } : {}) }, stamper);
			// Its review is done: the hold next took for it goes.
			await ctx.reviews?.release(repo, holdKey(commit, requiredString(args, "role")), reviewer).catch(() => undefined);
			if (verdict === "approve") await warmChecks("approved", commit);
			return cast;
		}
		case "merge": {
			// mergeChange reads the claims again itself, when it checks them.
			const registry = registered;
			// Anyone may merge a change whose conventions hold; it merges as its claim's agent, and the stamp says who asked.
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			const holder = own?.agent;
			if (holder && holder !== agentArg("agent")) throw new Error(`[409] ${change} is ${holder}'s change: merge it as ${holder}`);
			// Onto the branch its claim names, through that branch's own line.
			const into = own?.into ?? branch;
			// Not before what it depends on has merged into that same branch.
			const waits = await waitingOn(own?.after ?? [], into);
			if (waits.length) return { ok: false, reasons: waits };
			return mergeChange({
				remote: await write(),
				branch: into,
				...(into !== branch ? { scope: (file: string) => scopeFile(file, into, branch) } : {}),
				store,
				votes,
				// The branch's settings: the repo's, with what a branch rule changes.
				policy: branchSettings(registry, into).policy,
				verify: branchSettings(registry, into).verify,
				runChecks: ctx.runChecks?.(repo, into === branch ? undefined : into),
				stamper,
				stampKey: registry?.stampKey,
				source: await changeSource(holder ?? agentArg("agent"), "read", change),
				change,
				agent: agentArg("agent"),
			});
		}
		case "build": {
			if (!ctx.startBuilder) throw new Error("[501] hosted builders aren't available here");
			if (ctx.mayUseHosted && !(await ctx.mayUseHosted())) throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
			const intent = requiredString(args, "intent");
			const change = changeId(intent);
			const claimed = await store.claim({ change, agent: "githive-builder", paths: normalizeClaim(requiredPaths(args, "paths")), intent, staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) }, stamper);
			if (!claimed.ok) return claimed;
			return ctx.startBuilder({ repo, change });
		}
		case "request_review": {
			if (ctx.mayUseHosted && !(await ctx.mayUseHosted())) throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
			const change = requiredString(args, "change");
			const registry = registered;
			if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim: claim the change's paths first`);
			if (!ctx.requestReview) throw new Error("[501] hosted reviewers aren't available here");
			const policy = branchSettings(registry, (await claimOf(change))?.into).policy;
			// By default a general review, and every role that can veto a change to these paths.
			const roles = Array.isArray(args.roles) && args.roles.length ? (args.roles as string[]) : hostedRoles(effectivePolicy(policy, (await claimOf(change))?.paths ?? []).vetoes);
			return ctx.requestReview({ repo, change, roles, ...(typeof args.summary === "string" ? { summary: args.summary } : {}) });
		}
		case "audit": {
			const { merges, violations } = await runAudit(ctx, repo);
			return { merges, open: violations.filter((v) => !v.resolvedBy).length, violations };
		}
		case "revert": {
			const { violations } = await runAudit(ctx, repo);
			return revertViolation({ remote: await write(), branch: projectBranch(registered), claims, votes, stamper, target: requiredString(args, "commit"), violations, agent: actAs("agent") });
		}
		case "status": {
			const change = requiredString(args, "change");
			const held = (await claimOf(change)) ?? null;
			const released = held ? undefined : (await changeOf(change)).released.at(-1);
			const votesOn = async (head: string) => (await votes.readFor([head])).votes;
			const waits = held?.after?.length ? await waitingOn(held.after, held.into ?? branch) : [];
			return { change, claim: held, ...(released ? { released } : {}), ...(waits.length ? { waitsOn: waits } : {}), ...(await changeStatus(ctx, repo, registered, votesOn, change, held ?? undefined, held?.agent ?? released?.agent)) };
		}
		case "check":
		{
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			const source = own ? await changeSource(own.agent, "read", change).catch(() => null) : null;
			if (!source) throw new Error(`[409] changes/${change} has nothing pushed to check`);
			const checked = await checkChange({ project: await ctx.remote(repo, "read"), branch: own?.into ?? branch, source, claims: own ? [own] : [], change });
			// Pushed and checked: a merge is likely within minutes, so its check container warms up meanwhile.
			await warmChecks("checked", change);
			return checked;
		}
		case "register": {
			if (ctx.agent) throw new Error(`[409] you're signed in as ${ctx.agent}: what you write is already attributed to you, with no key`);
			const agent = requiredString(args, "agent");
			if (agent.includes("/")) throw new Error("[400] names with \"/\" are signed-in agents' (<handle>/<agent>); register a name without one");
			if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted) throw new Error("[403] githive- names are GitHive's hosted agents'");
			const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const newKey = `${agent}.${secret}`;
			const outcome = await registerAgent(claims, { agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) }, stamper);
			if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
			return { agent, key: newKey, note: "Keep this key secret; it is shown once. Send it as X-GitHive-Agent-Key (or agent_key) with every call." };
		}
		default:
			throw new Error(`[400] unknown tool ${name}`);
	}
}
