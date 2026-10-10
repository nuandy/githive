import type { GitHubLink } from "../github";
import { actionsChecks, mirrorTo, onActions } from "./actions-checks";
import git from "isomorphic-git";
import { GitCasLog } from "../record-log";
import { fail, requiredPaths, requiredString, statusOf } from "../errors";
import { branchHead, type Remote, Workspace } from "../git";
import { projectBranch } from "../project-branch";
import { Timing } from "../timing";
import { annotate, destroys, reads, writes } from "../tool-annotations";
import { changeId, claimCovering, normalizeClaim } from "../claim-paths";
import { audit } from "./audit";
import { checkChange } from "./check";
import { claimStore, type ClaimStore } from "./claim-store";
import {
	changeSettings,
	recordBranch,
	registerAgent,
	registerAgents,
	shardClaims,
	shardingReason,
	startRepo,
	type ClaimRecord,
	type Registry,
} from "./claims";
import {
	mergeRecordOf,
	readMainMerges,
	readRecordHistory,
	readRefHistories,
	readShardHistories,
	type BranchCommit,
} from "./git-records";
import { artifactsInspect, type ReadHistory } from "./batch-reads";
import { atMost, type BatchGit, type Candidate, type CheckRunner, mergeChange } from "./merge";
import { type Landed, type Landing, type LandingView, lastLandedOn } from "./landing";
import { revertViolation } from "./revert";
import type { Stamper } from "./stamp";
import {
	approval,
	countedVotes,
	DEFAULT_GRANT,
	effectivePolicy,
	grantWarnings,
	openFlag,
	shardVotes,
	votesShardingReason,
	type ReviewPolicy,
	type VoteRecord,
	type Votes,
} from "./votes";
import { VOTE_BUCKETS, type VoteStore, voteStore, votesPrefix } from "./vote-store";
import {
	addWork,
	addWorks,
	backlogFor,
	holdKey,
	ROLE_WAIT_MS,
	reviewsFor,
	type Work,
	waitingRoleReviews,
	workId,
} from "./work";
import { abandoned, BUILDING_IDLE_MS, type ChangeSigns } from "./staleness";
import { claimInto, isReservedPath, presentClaim, scopeFile, scopePaths } from "./branch-scope";
import { BRANCH_PATTERN, type BranchRule, settingsForBranch } from "./branch-rules";
import { DEFAULT_SKIP_CHECKS, SKIP_PATTERN } from "./check-scope";
import type { Abandoned } from "./claims";

// GitHive's MCP tools (see docs/design.md). Each tool is stateless: it reads or writes the repo's records
// in Git and reports what Git said. Nothing here decides for anyone. An agent could do the same with plain
// git, and the audit reads the same records either way.

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
	/** Tells the dashboard's open pages that the repo's records changed. */
	ping?: (repo: string) => Promise<void>;
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
	noteHeads?: (repo: string, seen: Record<string, string | null>, readAt?: number) => Promise<void>;
	/** A GitHub repo (owner/name) through GitHive's App, or null if the App isn't installed. Unset without GitHub. */
	github?: (repo: string) => Promise<GitHubLink | null>;
	/** What landed on a branch since this agent was last told (see RepoCache.landingNews). */
	news?: (repo: string, branch: string, agent: string) => Promise<Landed[]>;
	/** A branch's head, briefly cached and shared by the merges watching it (see MergeInput.branchHead). */
	branchHead?: (repo: string, branch: string) => Promise<string | null>;
	/** Queues forks to be made in the background: the repo's seeds, or the named agents' own. */
	prepareForks?: (repo: string, items: "seeds" | string[]) => Promise<void>;
	/** Review holds set by review_access, so the reviews tool shows which reviews are taken (see review-holds.ts). */
	reviews?: {
		held(repo: string): Promise<Record<string, string[]>>;
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

/** No reviews by default, as on GitHub: a claimed, pushed change merges as is. A repo opts in through settings. */
export const DEFAULT_POLICY: ReviewPolicy = { required: 0, vetoes: [] };
const HOSTED_PREFIX = "githive-";
const DEFAULT_SHARD_DEPTH = 2;
/** Records repos per sharded repo. Artifacts takes one push at a time per repo, so shards are spread out. */
const DEFAULT_RECORDS_REPOS = 16;
/** No claim goes stale sooner than this after its agent last claimed (see staleness.ts). */
const STALE_AFTER_MS = BUILDING_IDLE_MS;
/** How long a change's head, once seen, is taken as current (see openHeads). */
const HEAD_SEEN_MS = 5 * 60_000;
/** How long a head reported by a push event stays current. Reads only catch a lost event. */
const HEAD_PUSHED_MS = 30 * 60_000;
/** How many stale or unseen heads one call reads (see openHeads). */
const HEADS_READ_A_CALL = 6;
/** Concurrent fork head reads. A Worker request holds at most six connections; the runtime cancels any past that. */
const HEAD_READS_AT_ONCE = 6;
/** The most reviews or backlog items a call lists; the rest are only counted. */
const LISTED_AT_MOST = 40;
/** The most agents register, or work items add_work takes, in one call. */
const MOST_AT_ONCE = 500;
const claimsRef = (repo: string) => `refs/notes/githive-claims/${repo}`;
const votesRef = (repo: string) => `refs/notes/githive-votes/${repo}`;
/** The checks a repo runs in containers: none when they run on GitHub Actions. */
const containerChecks = (verify: string[] | undefined) => (onActions(verify) ? [] : (verify ?? []));

const workRef = (repo: string) => `refs/notes/githive-work/${repo}`;

export const INSTRUCTIONS = `GitHive: many agents work on one repository at once. Nobody enforces the rules; every agent follows them, and an audit anyone can run shows who didn't.
Name a repo as <owner>/<name> (a person's or an org's), as on GitHub; what you may do in it depends on your permission there (read, review, write, admin), and an agent has its owner's.
Nobody assigns work: you look and choose. Your own changes first (\`status\` shows each one's votes, with the evidence for any rejection to fix, and what it still needs): revise one sent back, merge one approved, finish one you claimed but haven't pushed. Then \`reviews\` lists reviews you may give, and \`backlog\` the pieces of work free to build (\`add_work\` adds to it); \`claims\` shows who holds what. Pick one, do it, look again. Each list comes in an order of your own, so agents looking at once spread out: take the first that suits you, unless you have a reason not to. Two agents picking the same piece both try: the claim decides, and the other picks again.
Conventions:
1. \`claim\` the paths you will change before editing; edit only inside your claim. A refusal names who holds what: narrow your claim, or ask them. A change lands on the project's branch unless its claim says \`into\` another (a feature branch, a release branch); claims are per branch, so the same paths on two branches don't conflict. A branch that doesn't exist yet is made by the claim when you also say \`from\` (the branch to make it from).
Work that depends on other unmerged work goes on a feature branch, and the project's branch only receives finished features. Within a branch, \`after\` orders it: a change claimed with after: [x] merges only once x has merged into the same branch. A branch may have settings of its own (\`settings\` branch_rules: feature/* with checks only, say, or release/* needing a person's approval): \`status\` shows what a change needs on its branch. A finished branch merges into another as one change: \`claim\` with \`source\` (the branch to merge) and \`into\`; the claim is what the branch changed, its tip becomes your change, and it's reviewed, checked and merged like any other. A conflict with the branch it lands on is fixed by merging that branch into the source the same way, then claiming again.
2. Work on a branch changes/<change>, started from the branch the change lands on (the project's, or its claim's \`into\`: \`credentials\` names it), and push it to your own fork (\`credentials\` with your change: one fork per agent, for all its changes; only you can write it). The project's branch (\`start\` names it: main, master, ...) is written only through the toolkit.
3. Reviewers get the change's code with \`review_access\` (read-only: its branch in the author's fork, and the project to diff against), then \`vote\` on the exact commit they reviewed. A change merges with the policy's approvals, including every veto role's, and no veto; a veto role counts only from whoever \`start\` granted it (by default people and GitHive's reviewers), so \`register\` with your key to vote as one. Approvals count once per verified identity (register reviewers so each is its own), and never the change's author. \`status\` shows your change's votes, with the evidence for any rejection to fix, and what's still needed.
4. Run \`check\` after you push: it test-merges your change with the branch it lands on and lists files outside your claim, so you hear about problems before merging.
5. \`merge\` lands your approved change, with trailers recording the claims and votes it checked, then releases your claim. It lands together with every other approved change into the same branch, checked once as a batch, and returns when yours has landed or been sent back (its checks failed: \`status\` shows the output), or after 10 minutes saying it's still waiting (pending: call merge again to go on waiting). Another agent's \`merge\` may land your change too, as soon as its head is approved, before you call merge: \`status\` then shows it merged, and there's nothing left to do. Merge by hand only with the same trailers.
6. Claiming again (same paths) keeps your claim active. A claim is freed only when its change waits on its own agent and gets no answer: 30 minutes with nothing pushed, or 2 hours after changes were asked for (its checks failing counts), or it was approved and not merged. Then whoever claims its paths (or its change) releases it, as can anyone (\`release\` with stale: true). A change waiting for review, being checked to land, or on a person is never freed.
7. Anyone may \`revert\` a commit \`audit\` reports; the audit then counts it resolved.
8. Something agents can't settle (reviewers disagree, a trade-off needs an owner)? \`ask_human\` with the reason: a person sees it in their inbox and decides with their own vote.
9. \`request_review\` asks GitHive's hosted reviewers for votes on your change; \`build\` has GitHive's hosted builder make a change from start to merge.
10. Who you are: signed in to GitHive (OAuth, or an agent token), you are your agent, <handle>/<agent>, with nothing more to do. Agents that share an Access identity instead tell themselves apart with \`register\`: it returns your agent key once; send it (header X-GitHive-Agent-Key, or agent_key) with every call, and what you write is attributed to you. A registered name is never used without its key.
\`audit\` replays the records and lists every broken convention, with the commit and the agent.`;

const str = { type: "string" } as const;
const TOOL_LIST = [
	{
		name: "settings",
		description:
			"Set up GitHive on a repo, or change how it's set up; whatever you leave out stays as it is. A repo's first settings start GitHive on it (with none given, the defaults: no reviews, so a change merges once it's pushed, and no checks), and reply with the instructions agents follow. The review policy: required approvals, vetoes, escalate (stricter rules for chosen paths), grants (who may vote as each role that can block a merge: registered agent names, 'person:*', a verified identity like 'person:<who>' or 'service:<id>', a pool 'service:<id>/*' (every agent registered under it, never on its own team's changes), a team '@<org>/<team>', 'githive' for GitHive's reviewers; unlisted roles: people and GitHive's reviewers). verify: the checks run before each merge ([] for none). Each check is a shell command, run with bash at the repo's top on the merged code (exit 0 passes, the first failure stops the run) in a Linux container with Node 24, npm and git, plus Python, Go or Rust when the repo uses them; dependencies are installed first; up to 10 minutes per command; no secrets or environment variables, so a test needing a database or an API key fails. Each merge is held to the settings in force when it merged: the audit replays them from the records. Returns the settings now. branch_rules sets other branches' settings by pattern (feature/*, release/*, a name), the first match winning: each changes only the policy fields and checks it names (verify [] for none; left out, the repo's); [] clears them. The project's branch always has the repo's settings. skip_checks lists what the checks skip: a change touching only these merges without them (*.md, docs/, licenses and images by default; a file under test/, fixtures/ or examples/ always runs them); [] makes them always run. github connects a GitHub repo ('owner/name', '' for none) through GitHive's GitHub app, installed there: main is pushed back to it after every landing, and verify ['github-actions'] runs the checks on its Actions instead of in containers (a workflow that runs on pushes to githive/checks/**). Only when GitHive starts on a repo: how claims are kept. They start in one record and shard per path, 2 segments deep over 16 records repos, once the load calls for it (8 agents holding claims, or over 15 claim writes a minute); shard_depth shards now, this deep (0: never), and records_repos is how many repos the shards are spread over, since a repo takes one push at a time.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				github: str,
				shard_depth: { type: "number" },
				records_repos: { type: "number" },
				required: { type: "number" },
				vetoes: { type: "array", items: str },
				escalate: {
					type: "array",
					items: {
						type: "object",
						properties: {
							paths: { type: "array", items: str },
							required: { type: "number" },
							vetoes: { type: "array", items: str },
						},
						required: ["paths"],
					},
				},
				grants: { type: "object", additionalProperties: { type: "array", items: str } },
				verify: { type: "array", items: str },
				skip_checks: { type: "array", items: str },
				branch_rules: {
					type: "array",
					items: {
						type: "object",
						properties: {
							pattern: str,
							required: { type: "number" },
							vetoes: { type: "array", items: str },
							grants: { type: "object", additionalProperties: { type: "array", items: str } },
							verify: { type: "array", items: str },
						},
						required: ["pattern"],
					},
				},
			},
			required: ["repo"],
		},
	},
	{
		name: "credentials",
		description:
			"Git access. With your change: a write token for its own fork, where its branch changes/<change> lives. Without: read access to the project repo.",
		inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo"] },
	},
	{
		name: "claims",
		description: "The claims in force: who holds which paths, and why.",
		inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] },
	},
	{
		name: "claim",
		description:
			"Claim paths for your change (again to extend it, or to keep it active). Into the project's branch, or `into` another (made from `from` if it doesn't exist yet; claims are per branch). `source` merges that whole branch into it instead (the paths are what the branch changed, and its tip is the change). `after` names changes it depends on: it merges only once they have merged into the same branch. Refused, naming the holder, if another claim on that branch overlaps; a claim in the way that its agent has abandoned (see release) is released as stale instead.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				change: str,
				agent: str,
				paths: { type: "array", items: str },
				intent: str,
				into: str,
				from: str,
				after: { type: "array", items: str },
				source: str,
			},
			required: ["repo", "change", "agent", "intent"],
		},
	},
	{
		name: "release",
		description:
			"Release a claim: yours, or with stale: true another agent's it has abandoned: its change waits on that agent, unanswered for 30 minutes with nothing pushed, or 2 hours after changes were asked for, failed checks, or approval without a merge. Never one waiting for review, being checked to land, or on a person.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } },
			required: ["repo", "change", "agent"],
		},
	},
	{
		name: "add_work",
		description:
			"Add a piece of work to the repo's backlog, for agents to take (see backlog): a title, what it should do (intent), and the paths it's likely to touch. Its id (from the title unless given) is the change name to claim it under; `after` names pieces it depends on, and next hands it out only once they've merged. Or `items`: many pieces at once (each with these fields), in one write; ids in the backlog already are left as they are.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				title: str,
				intent: str,
				paths: { type: "array", items: str },
				after: { type: "array", items: str },
				id: str,
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: str,
							intent: str,
							paths: { type: "array", items: str },
							after: { type: "array", items: str },
							id: str,
						},
						required: ["title", "intent"],
					},
				},
				agent: str,
			},
			required: ["repo", "agent"],
		},
	},
	{
		name: "review_access",
		description:
			"Start reviewing a change: a read-only token for the author's fork, the change's branch (changes/<change>) and its pushed head, and read access to the project to diff against. It marks you as reviewing that commit in `role` (review unless you name one that can block), so others looking at reviews see it taken; the mark goes when you vote, or in 15 minutes. Anyone may review; each grant is logged.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, role: str, agent: str },
			required: ["repo", "change"],
		},
	},
	{
		name: "reviews",
		description:
			"The reviews you may give now: changes pushed, not yours, not voted on by you and not sent back, still needing approvals you can give (a role that can block, if you hold one it awaits; else ordinary ones), with how many more each needs and who's reviewing it already. Reviews you started first, then roles that can block, fewest approvals, oldest; equals in an order of your own, so agents looking at once don't all take the same. Pick one, review_access it, vote.",
		inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] },
	},
	{
		name: "backlog",
		description:
			"The repo's backlog as you may take it: pieces free to build now (nobody has claimed them, nor their paths, and what they depend on has merged; equally good, in an order of your own), and why the others wait. Build one by claiming it with its id as the change.",
		inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] },
	},
	{
		name: "vote",
		description: "Record your review verdict on the exact commit you reviewed.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				commit: str,
				reviewer: str,
				role: str,
				verdict: { type: "string", enum: ["approve", "reject"] },
				evidence: str,
			},
			required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"],
		},
	},
	{
		name: "merge",
		description:
			"Merge changes/<change> into the project's branch if the conventions hold, recording what was checked, then release the claim.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str },
			required: ["repo", "change", "agent"],
		},
	},
	{
		name: "build",
		description:
			"Have GitHive's hosted builder make a change: it claims the paths, builds on changes/<change>, asks the hosted reviewers when done, and the change merges once approved and checked.",
		inputSchema: {
			type: "object",
			properties: { repo: str, intent: str, paths: { type: "array", items: str } },
			required: ["repo", "intent", "paths"],
		},
	},
	{
		name: "request_review",
		description:
			"Ask GitHive's hosted reviewer agents to review your change's current commit (by default a general review, and every role that can veto it); each votes with vote.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, roles: { type: "array", items: str }, summary: str },
			required: ["repo", "change"],
		},
	},
	{
		name: "audit",
		description:
			"Replay the records and list every broken convention, with the commit and the agent (and whether a revert has resolved it).",
		inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] },
	},
	{
		name: "revert",
		description:
			"Revert a commit the audit reports: its files go back to how they were before it, in a commit naming what it reverts.",
		inputSchema: {
			type: "object",
			properties: { repo: str, commit: str, agent: str },
			required: ["repo", "commit", "agent"],
		},
	},
	{
		name: "status",
		description:
			"Where a change stands: its claim (or how it ended; landed: it's in, though its claim isn't released yet, so don't merge it again), its branch head, the votes on that head with their evidence, the approvals still needed, and what GitHive's hosted agents on it are doing.",
		inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] },
	},
	{
		name: "check",
		description:
			"An early check on your change, any time before merging: whether it still merges cleanly into the project's branch, and any files outside your claim. (Claims keep changes apart, so it doesn't check other changes: only files outside a claim could collide.) Reports only.",
		inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] },
	},
	{
		name: "ask_human",
		description:
			"Ask a person to decide something about a change you can't settle among agents (reviewers disagree, a trade-off needs an owner). It waits in their inbox until a person votes on the change's commit.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str, reason: str },
			required: ["repo", "change", "agent", "reason"],
		},
	},
	{
		name: "register",
		description:
			"Register your agent name and get its secret key (shown once), so what you write is attributed to you even if you share an Access identity. With your current key, rotates it. Or `agents`: several new names at once (none registered yet), in one write, each with its own key.",
		inputSchema: {
			type: "object",
			properties: { repo: str, agent: str, agents: { type: "array", items: str } },
			required: ["repo"],
		},
	},
];
// Every tool takes the caller's agent key, for clients that can't set the header.
export const TOOLS = annotate(
	TOOL_LIST.map((t) => ({
		...t,
		inputSchema: {
			...t.inputSchema,
			properties: {
				...t.inputSchema.properties,
				agent_key: {
					type: "string",
					description: "Your agent key from register, if you can't send the X-GitHive-Agent-Key header",
				},
			},
		},
	})),
	{
		settings: writes("Set up a repo's review policy and checks", { idempotent: true }),
		credentials: writes("Get Git access", { idempotent: true }),
		claims: reads("List claims"),
		review_access: writes("Start reviewing a change", { idempotent: true }),
		reviews: reads("List reviews you may give"),
		backlog: reads("List the backlog"),
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

const sha256 = async (text: string) =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

/** The agent name a key is for, checked against the registry; keys are `<agent>.<secret>`. */
async function keyAgent(registry: Registry | undefined, key: string) {
	const agent = key.slice(0, Math.max(0, key.lastIndexOf(".")));
	const record = agent ? registry?.agents?.[agent] : undefined;
	if (!record || record.keyHash !== (await sha256(key))) throw new Error("[403] unknown agent key");
	return agent;
}

/** Throws unless the caller may act as `name`. Callers with a key or sign-in act only as themselves. */
function mayActAs(
	name: string,
	acting: string | undefined,
	registry: Registry | undefined,
	hosted: boolean | undefined,
) {
	if (acting) {
		if (name !== acting) throw new Error(`[403] you act as ${acting}; you can't act as ${name}`);
		return;
	}
	if (hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) throw new Error("[403] githive- names are GitHive's hosted agents'");
	// Names like person:… and service:… are verified identities, which an agent can't take on.
	if (name.includes(":")) throw new Error("[403] an agent's name can't contain \":\"");
	// <handle>/<agent> names belong to signed-in agents, verified by their token.
	if (name.includes("/"))
		throw new Error(`[403] ${name} is a signed-in agent's name: sign in to GitHive as it to act as it`);
	if (registry?.agents?.[name]) throw new Error(`[403] ${name} is registered: call with its agent key`);
}

export type Args = Record<string, unknown>;

/** What the advice tools (claims, reviews, backlog) read: the claims in force and the changes merged. */
export interface ClaimsAdvice {
	claims: ClaimRecord[];
	merged: string[];
}

/** A record's log: the context's shared one, or one for this call. */
function recordLog<S>(ctx: ToolContext, repo: string, ref: string): GitCasLog<S> {
	return ctx.records ? ctx.records<S>(repo, ref) : new GitCasLog<S>(() => ctx.remote(repo, "write"), repo, ref);
}

/** Reads the claims advice fresh from the records (see keptClaims). */
async function advice(ctx: ToolContext, repo: string): Promise<ClaimsAdvice> {
	const log = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const head = await log.read();
	const view = await storeFor(ctx, repo, head?.commit.state, { log, head }).read();
	const branch = projectBranch(head?.commit.state);
	return {
		claims: view.claims.map((c) => presentClaim(c, branch)),
		merged: view.released.filter((r) => r.mergedAs).map((r) => r.change),
	};
}

/** The settings arguments that make up the review policy. */
const POLICY_FIELDS = ["required", "vetoes", "escalate", "grants"] as const;

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

/** Parses branch_rules from settings: a pattern each, with the policy fields and checks it overrides. */
function branchRulesFrom(value: unknown, base: ReviewPolicy): BranchRule<ReviewPolicy>[] {
	if (!Array.isArray(value))
		throw new Error("[400] branch_rules is a list of rules: each a pattern, and what it changes");
	return value.map((raw, i) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error(`[400] branch_rules[${i}] is a rule: a pattern, and what it changes`);
		const rule = raw as Args;
		const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
		if (!pattern || !BRANCH_PATTERN.test(pattern))
			throw new Error(
				`[400] branch_rules[${i}].pattern is a branch name, with * for any run of characters (feature/*)`,
			);
		// Keep only the fields the rule sets, so the rest follow the repo's settings as they change.
		const full = policyFrom(rule, base);
		const policy = Object.fromEntries(
			POLICY_FIELDS.filter((f) => rule[f] !== undefined).map((f) => [f, full[f]]),
		) as Partial<ReviewPolicy>;
		const verify = rule.verify === undefined ? undefined : checksFrom(rule.verify);
		if (!Object.keys(policy).length && !verify)
			throw new Error(
				`[400] branch_rules[${i}] (${pattern}) changes nothing: set required, vetoes, escalate, grants or verify`,
			);
		return { pattern, ...(Object.keys(policy).length ? { policy } : {}), ...(verify ? { verify } : {}) };
	});
}

/** Parses skip_checks: patterns like *.md or docs/ for files the checks skip. */
function skipPatternsFrom(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || !SKIP_PATTERN.test(p.trim())))
		throw new Error("[400] skip_checks is a list of patterns, like *.md or docs/ ([] for nothing)");
	return [...new Set((value as string[]).map((p) => p.trim()))];
}

/** A review policy from settings' arguments, falling back to `base` for any left out. */
function policyFrom(args: Args, base: ReviewPolicy): ReviewPolicy {
	const required = typeof args.required === "number" ? args.required : base.required;
	if (!Number.isInteger(required) || required < 0)
		throw new Error("[400] required is a whole number of approvals, 0 for none");
	const grants = args.grants !== undefined ? validGrants(args.grants) : base.grants;
	return {
		required,
		vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : base.vetoes,
		escalate: Array.isArray(args.escalate) ? (args.escalate as ReviewPolicy["escalate"]) : base.escalate,
		// Without grants, every role keeps its default holders.
		...(grants && Object.keys(grants).length ? { grants } : {}),
	};
}

/** Parses settings' github ("owner/name", or "" for none). Refused unless GitHive's App is installed there. */
async function githubFrom(ctx: ToolContext, value: unknown): Promise<{ repo: string } | null> {
	if (value === "" || value === null) return null;
	if (typeof value !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.trim()))
		throw new Error('[400] github is "owner/name", or "" for none');
	if (!ctx.github) throw new Error("[501] GitHub isn't set up on this GitHive (its App's ID and key)");
	const repo = value.trim();
	if (!(await ctx.github(repo)))
		throw new Error(`[409] GitHive's GitHub app isn't installed on ${repo}: install it there first`);
	return { repo };
}

function checksFrom(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("[400] verify is a list of commands, [] for none");
	return value.filter((c): c is string => typeof c === "string" && !!c.trim());
}

/** Validates role grants: each role maps to a list of who may vote as it. */
function validGrants(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("[400] grants maps each role to who may vote as it");
	const grants: Record<string, string[]> = {};
	for (const [role, who] of Object.entries(value)) {
		if (!Array.isArray(who) || !who.every((w) => typeof w === "string" && w.trim()))
			throw new Error(
				`[400] grants.${role} is a list: agent names, "person:*", "person:<who>", "service:<id>", a team "@<org>/<team>" or "githive"`,
			);
		grants[role] = who.map((w) => w.trim());
	}
	return grants;
}

/**
 * Flags each blocking-role review that has waited unheld for ROLE_WAIT_MS, once per commit and role,
 * so a person can take it or nudge its holders.
 */
async function tellPeopleOfWaitingRoles(
	ctx: ToolContext,
	repo: string,
	votes: VoteStore,
	policy: ReviewPolicy,
	open: { claim: ClaimRecord; head: string | null }[],
	counted: VoteRecord[],
	policyOf?: (claim: ClaimRecord) => ReviewPolicy,
) {
	if (!ctx.reviews?.waits || !ctx.reviews.told) return;
	const waiting = waitingRoleReviews({
		policy,
		...(policyOf ? { policyOf } : {}),
		open,
		votes: counted,
		held: await ctx.reviews.held(repo),
	});
	const seen = await ctx.reviews.waits(
		repo,
		waiting.map((w) => holdKey(w.head, w.role)),
	);
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
		sharding: registry?.shardDepth
			? { since: registry.shardedAt, because: registry.shardedBecause }
			: registry?.autoShard
				? "on demand"
				: "never",
	};
}

/** Shards the claims if the load calls for it (see shardingReason). Returns the new registry, or null. */
async function shardIfBusy(
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
		...(ctx.recordsRemote ? { recordsRemote: (k: number) => ctx.recordsRemote!(repo, k, "write") } : {}),
	});
}

/**
 * Shards the repo's votes if the load calls for it (see votesShardingReason), where its claims may shard.
 * Returns the votes record's head for the vote that follows, or undefined if it wasn't read.
 */
async function shardVotesIfBusy(
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
		...(ctx.recordsRemote ? { recordsRemote: (k: number) => ctx.recordsRemote!(repo, k, "write") } : {}),
		remote: () => ctx.remote(repo, "write"),
		log: ctx.records ? (ref) => ctx.records!<Registry>(repo, ref) : undefined,
	});
}

/**
 * When forks became per agent. A change claimed since then has no fork of its own, so none is looked
 * for, which saves a failed lookup per unpushed change. The date leaves a day's margin for deploys.
 */
const FORKS_PER_AGENT_SINCE = "2026-10-08T00:00:00Z";

/**
 * Where a repo's change branches live: changes/<change> in the agent's own fork. A change claimed before
 * forks were per agent, or at an unknown time, may still be in a fork of its own.
 */
function changeSourceFor(ctx: ToolContext, repo: string) {
	return async (agent: string, scope: "read" | "write", change?: string, since?: string): Promise<Remote> => {
		if (!ctx.changeRemote) throw new Error("[501] change forks aren't available here");
		const legacy = !!change && !!ctx.legacyChangeRemote && !(since && since >= FORKS_PER_AGENT_SINCE);
		if (scope === "write" || !legacy) return ctx.changeRemote(repo, agent, scope);
		const fork = await ctx.changeRemote(repo, agent, "read").catch(() => null);
		if (fork && (await branchHead(fork, `changes/${change}`).catch(() => null))) return fork;
		return (
			(await ctx.legacyChangeRemote!(repo, change!).catch(() => null)) ?? fork ?? ctx.changeRemote(repo, agent, "read")
		);
	};
}

/**
 * A change's pushed head, or null if nothing is pushed. A change claimed since forks were per agent is read
 * with one Artifacts API call on its agent's fork, far cheaper than listing refs over Git.
 */
async function changeHead(
	ctx: ToolContext,
	repo: string,
	agent: string,
	change: string,
	since?: string,
): Promise<string | null> {
	const ref = `changes/${change}`;
	if (ctx.forkHead && since && since >= FORKS_PER_AGENT_SINCE) return ctx.forkHead(repo, agent, ref);
	return branchHead(await changeSourceFor(ctx, repo)(agent, "read", change, since), ref);
}

/** Where a change stands: its head, the votes on it, its approval under the policy, and its hosted agents. */
async function changeStatus(
	ctx: ToolContext,
	repo: string,
	registry: Registry | null | undefined,
	votesOn: (head: string) => Promise<VoteRecord[]>,
	change: string,
	author: ClaimRecord | undefined,
	agent = author?.agent,
) {
	// No fork (or no branch on it) means nothing pushed yet.
	const head = await Promise.resolve()
		.then(() => changeHead(ctx, repo, agent ?? fail(409, `${change} has no agent`), change, author?.since))
		.catch(() => null);
	// Note the fresh head for reviews, backlog and merge (see openHeads).
	if (head) await ctx.noteHeads?.(repo, { [change]: head }).catch(() => undefined);
	// The claimed paths can escalate the policy (stricter for CI or deploy files, for example).
	const paths = author?.paths ?? [];
	// The branch it lands on decides the policy too (see branch-rules.ts).
	const policy = branchSettings(registry, author?.into).policy;
	const { required, vetoes } = effectivePolicy(policy, paths);
	const cast = head ? (await votesOn(head)).filter((v) => v.commit === head) : [];
	const outcome = head
		? approval({ votes: await countedVotes(cast, registry?.stampKey) }, head, policy, author, paths)
		: { approved: false, approvals: 0, vetoedBy: [], awaiting: vetoes };
	const hosted = ctx.agentStatus
		? await ctx.agentStatus(repo, change, head, hostedRoles(vetoes)).catch(() => undefined)
		: undefined;
	return { head, votes: cast, approval: { ...outcome, required }, ...(hosted ? { hosted } : {}) };
}

/**
 * The signs of whose turn a change is on: its head, the counted votes on it (stamps already checked),
 * any open question for a person, and whether it's in the batch being landed.
 */
export function changeSigns(input: {
	claim: ClaimRecord;
	head: string | null;
	counted: VoteRecord[];
	record: Pick<Votes, "votes" | "flags">;
	landing?: Pick<LandingView, "checking"> | null;
	policy: ReviewPolicy;
}): ChangeSigns {
	const { claim, head } = input;
	const counted = head ? input.counted.filter((v) => v.commit === head && v.reviewer !== claim.agent) : [];
	const outcome = head
		? approval(
				{ votes: counted },
				head,
				input.policy,
				{ agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) },
				claim.paths,
			)
		: undefined;
	return {
		active: claim.active,
		head,
		votes: counted.map((v) => ({ verdict: v.verdict, at: v.at })),
		approved: !!outcome?.approved,
		vetoed: !!outcome?.vetoedBy.length,
		landing: !!head && !!input.landing?.checking?.changes.some((c) => c.change === claim.change && c.head === head),
		asked: !!openFlag(input.record, claim.change, head),
	};
}

/**
 * Decides whether a claim that's in the way, or asked to be released as stale, is abandoned.
 * Everything is read fresh, because a release can't be undone.
 */
function abandonedRule(
	ctx: ToolContext,
	repo: string,
	registered: Registry | null | undefined,
	votes: VoteStore,
): Abandoned {
	return async (claim) => {
		// A failed read isn't "nothing pushed", which could release live work. Only a missing fork (409),
		// or no forks at all (501), means nothing is pushed.
		const head = await changeHead(ctx, repo, claim.agent, claim.change, claim.since).catch((err): null | undefined =>
			[409, 501].includes(statusOf(err).status) ? null : undefined,
		);
		if (head === undefined) return { abandoned: false, why: `${claim.change}'s head couldn't be read just now` };
		const view = await votes.readFor(head ? [head] : []);
		const counted = head
			? await countedVotes(
					view.votes.filter((v) => v.commit === head),
					registered?.stampKey,
				)
			: [];
		const shown = presentClaim(claim, projectBranch(registered));
		const landing = await ctx
			.landing?.(repo, shown.into ?? projectBranch(registered))
			.view()
			.catch(() => null);
		const signs = changeSigns({
			claim: shown,
			head,
			counted,
			record: view,
			landing,
			policy: branchSettings(registered, shown.into).policy,
		});
		const outcome = abandoned(signs, Date.now());
		return { abandoned: outcome.abandoned, why: outcome.waiting.why };
	};
}

/**
 * A change that merges branch `source` into `into` whole. Its claim is the files `source` changed since
 * it left `into`, and its tip becomes the change's branch, so it's reviewed, checked and merged as usual.
 */
async function branchMerge(ctx: ToolContext, repo: string, source: string, into: string) {
	if (source === into) throw new Error(`[400] a change can't merge ${into} into itself`);
	const project = await ctx.remote(repo, "read");
	const ws = await Workspace.clone(project, into).catch(() => fail(409, `there's no branch ${into}`));
	const tip = await ws.fetch("source", project, source).catch(() => fail(409, `there's no branch ${source}`));
	const files = await ws.changedPaths(await ws.mergeBase(await ws.head(), tip), tip);
	if (!files.length) throw new Error(`[409] ${source} has nothing ${into} doesn't have`);
	const paths =
		claimCovering(files) ?? fail(409, `${source} changes too much of ${into} to claim at once: merge it in parts`);
	return {
		tip,
		paths,
		// Push from the shallow workspace, or with the source's full history if the fork lacks what it leaves out.
		push: async (fork: Remote, change: string) => {
			const to = `refs/heads/changes/${change}`;
			await ws
				.pushAs(`refs/remotes/source/${source}`, to, fork)
				.catch(async () =>
					(await Workspace.clone(project, source, { depth: 1 << 20 })).pushAs(`refs/heads/${source}`, to, fork),
				);
		},
	};
}

/** Parses a work item for add_work, given alone or as one of its items. */
function workItemFrom(args: Record<string, unknown>) {
	const title = requiredString(args, "title");
	const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : workId(title);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
		throw new Error("[400] a work id is letters, digits, dots, dashes and underscores");
	const paths = args.paths === undefined ? undefined : normalizeClaim(requiredPaths(args, "paths"));
	const after = changeList(args.after, "after");
	return {
		id,
		title,
		intent: requiredString(args, "intent"),
		...(paths ? { paths } : {}),
		...(after.length ? { after } : {}),
	};
}

function changeList(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)))
		throw new Error(`[400] ${field} is a list of change ids`);
	return [...new Set(value as string[])];
}

/** The loop `change` would close by waiting on `after` (searching up to 50 changes), or undefined. */
async function dependencyLoop(
	change: string,
	after: string[],
	afterOf: (change: string) => Promise<string[]>,
): Promise<string[] | undefined> {
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

/** Branch names changes may land on: a safe subset of what Git allows. */
const BRANCH_NAME = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]+$/;

/**
 * Makes sure a branch other than the project's can take changes: already recorded, adopted as it is, or made
 * from `from`. A missing branch is never made without `from`, so a misspelt name is refused. The branch is
 * made before it's recorded, so a failed record is repaired on the next claim. Returns what it did, if anything.
 */
async function targetBranch(
	ctx: ToolContext,
	repo: string,
	input: {
		into: string;
		from?: string;
		registered: Registry | null | undefined;
		claims: GitCasLog<Registry>;
		agent: string;
		stamper?: Stamper;
	},
): Promise<string | undefined> {
	const { into, from, registered, claims, agent, stamper } = input;
	if (!BRANCH_NAME.test(into)) throw new Error(`[400] ${into} isn't a branch name changes can land on`);
	if (registered?.branches?.[into]) return undefined;
	const found = await branchHead(await ctx.remote(repo, "read"), into);
	if (found) {
		await recordBranch(claims, { name: into, base: found, agent }, stamper);
		return `changes land on ${into} from now on, as it is at ${found.slice(0, 8)}`;
	}
	if (!from)
		throw new Error(
			`[409] ${into} doesn't exist: claim again with from (the branch to make it from, ${projectBranch(registered)} say)`,
		);
	const ws = await Workspace.clone(await ctx.remote(repo, "write"), from, { depth: 1 }).catch(() =>
		fail(409, `can't make ${into} from ${from}: there's no branch ${from}`),
	);
	await ws.pushNewBranch(into);
	const base = await ws.head();
	await recordBranch(claims, { name: into, base, from, agent }, stamper);
	return `made ${into} from ${from} at ${base.slice(0, 8)}`;
}

/** Replays a repo's records from Git: the merges since GitHive started on it, and every broken convention. */
async function runAudit(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const remote = await t.time("token", () => ctx.remote(repo, "read"));
	// The votes don't depend on the registry, so read them in parallel.
	const votesRead = t.time("votes", () => readRecordHistory<Votes>(remote, votesRef(repo)));
	votesRead.catch(() => undefined);
	const registry = await t.time("registry", () => readRecordHistory<Registry>(remote, claimsRef(repo)));
	const baseline = registry[0]?.state.baseline;
	if (!baseline) throw new Error(`[409] GitHive hasn't started on ${repo}`);
	const start = registry[0].state;
	// Whether claims are sharded, from the start or later, is in the latest state.
	const latest = registry.at(-1)!.state;
	// Read with git in the repo's Gate when there is one: reading many merges in memory exhausts a Worker.
	const branchMerges = (from: string, branch: string) =>
		ctx.readBranch
			? ctx.readBranch(repo, from, branch).then((commits) => commits.map(mergeRecordOf))
			: readMainMerges(remote, from, branch);
	const [merges, shards, votesHistory] = await Promise.all([
		t.time("merges", () => branchMerges(baseline, projectBranch(start))),
		latest.shardDepth
			? t.time("shards", async () =>
					readShardHistories(
						latest.recordsRepos && ctx.recordsRemote
							? await Promise.all(
									Array.from({ length: latest.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read")),
								)
							: [remote],
						repo,
					),
				)
			: undefined,
		votesRead,
	]);
	// Once votes are sharded, their buckets are where the latest state says.
	const votesNow = votesHistory.at(-1)?.state;
	const voteBuckets = votesNow?.buckets
		? await t.time("buckets", async () =>
				readRefHistories<Votes>(
					votesNow.recordsRepos && ctx.recordsRemote
						? await Promise.all(
								Array.from({ length: votesNow.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read")),
							)
						: [remote],
					votesPrefix(repo),
				),
			)
		: undefined;
	// Merges on other branches, each read from where it started, with files named as their claims name them.
	const project = projectBranch(start);
	const onBranches = (
		await t.time("branches", () =>
			Promise.all(
				Object.entries(latest.branches ?? {}).map(async ([name, record]) =>
					(await branchMerges(record.base, name)).map((m) => ({
						...m,
						branch: name,
						claimFiles: m.files.map((f) => scopeFile(f, name, project)),
					})),
				),
			),
		)
	).flat();
	const all = [...merges, ...onBranches];
	const violations = await t.time("audit", () =>
		audit({
			registry,
			...(shards ? { shards } : {}),
			votes: votesHistory,
			...(voteBuckets ? { voteBuckets } : {}),
			policy: start.policy ?? DEFAULT_POLICY,
			verify: start.verify,
			merges: all,
		}),
	);
	return { merges: all.length, violations };
}

/**
 * One change's history for its dashboard page: its claim (or how it ended), its last 50 commits
 * newest first, every vote on them, and its merge if it merged.
 */
export async function changeHistory(ctx: ToolContext, repo: string, change: string) {
	const t = ctx.timing ?? new Timing();
	const registry = (await t.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit
		.state;
	if (!registry?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await t.time("change", () => storeFor(ctx, repo, registry).readChange(change));
	if (!record && !released.length) throw new Error(`[404] no change ${change} on ${repo}`);
	// The change's own commits are those since it left the branch it lands on.
	const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
	const claim = record ? presentClaim(record, projectBranch(registry)) : undefined;
	const mergedAs = released.find((r) => r.mergedAs)?.mergedAs;
	const commits = await Promise.resolve()
		.then(() =>
			t.time("fork", () => changeSourceFor(ctx, repo)(claim?.agent ?? released.at(-1)!.agent, "read", change)),
		)
		.then(async (source) => {
			// Shallow: a change is a few commits on a recent head, and finding the merge base deepens it if needed.
			const ws = await t.time("clone", () => Workspace.clone(source, `changes/${change}`, { depth: 8 }));
			const head = await ws.head();
			// For a merged change, its base is found from the merge's first parent, not the branch's current head.
			const projectHead = await t.time("project", async () =>
				ws.fetch("project", await ctx.remote(repo, "read"), branch),
			);
			const before = mergedAs ? (await ws.ensureCommit(mergedAs)).commit.parent[0] : projectHead;
			const stop = await t.time("base", () => ws.mergeBase(before, head));
			const own = [];
			for (const { oid, commit } of await git.log({ fs: ws.fs, dir: "/repo", ref: head, depth: 50 })) {
				if (oid === stop) break;
				own.push({
					commit: oid,
					message: commit.message.trim(),
					author: commit.author.name,
					at: new Date(commit.author.timestamp * 1000).toISOString(),
				});
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
 * A person's vote from the dashboard on a change's current commit, stamped with their verified identity
 * and counted like any other vote (never the author's). It also answers any open question about the change.
 */
export async function voteAsPerson(
	ctx: ToolContext,
	repo: string,
	change: string,
	input: { role: string; verdict: "approve" | "reject"; evidence: string },
	person: string,
) {
	if (!person.startsWith("person:"))
		throw new Error("[403] only a person signed in through Access votes from the dashboard; agents use vote");
	if (!input.role?.trim()) throw new Error("[400] a vote needs a role");
	if (input.verdict !== "approve" && input.verdict !== "reject") throw new Error("[400] verdict is approve or reject");
	if (typeof input.evidence !== "string" || !input.evidence.trim())
		throw new Error("[400] a vote needs evidence: what you checked");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to vote on`);
	const head = await changeHead(ctx, repo, claim.agent, change, claim.since).catch(() => null);
	if (!head) throw new Error(`[409] ${change} has nothing pushed to vote on`);
	const stamper = await ctx.stamper?.();
	const teams = (await ctx.teamsOf?.(repo)) ?? [];
	await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registry, person)).vote(
		{
			commit: head,
			reviewer: person,
			role: input.role,
			verdict: input.verdict,
			evidence: input.evidence,
			...(teams.length ? { teams } : {}),
		},
		stamper,
	);
	await ctx.ping?.(repo).catch(() => undefined);
	return { commit: head, role: input.role, verdict: input.verdict };
}

/**
 * Makes or adopts a branch from the dashboard, as a claim with `into` and `from` would,
 * recorded under the person's name.
 */
export async function makeBranch(
	ctx: ToolContext,
	repo: string,
	input: { name: string; from: string },
	person: string,
) {
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const registered = (await claims.read())?.commit.state;
	if (!registered?.baseline)
		throw new Error(`[409] GitHive hasn't started on ${repo}: its admins start it with settings`);
	if (input.name === projectBranch(registered) || registered.branches?.[input.name])
		throw new Error(`[409] ${input.name} takes changes already`);
	const made = await targetBranch(ctx, repo, {
		into: input.name,
		from: input.from,
		registered,
		claims,
		agent: person,
		...(ctx.stamper ? { stamper: await ctx.stamper() } : {}),
	});
	await ctx.ping?.(repo).catch(() => undefined);
	return { name: input.name, made };
}

/**
 * Merges a change from the dashboard: the same batched, checked merge an agent asks for,
 * made as the change's agent and stamped with the person who asked.
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

/** The audit for the dashboard. It replays every record, so it runs apart from the snapshot. */
export async function repoAudit(ctx: ToolContext, repo: string) {
	const { merges, violations } = await runAudit(ctx, repo);
	const open = violations.filter((v) => !v.resolvedBy).length;
	await ctx.summarize?.(repo, { merged: merges, violations: open }).catch(() => undefined);
	return { merges, open, violations };
}

/** The dashboard's view of a repo, read from the records' tips. The audit is separate (see repoAudit). */
export async function repoSnapshot(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const [registry, votes] = await t.time("records", () =>
		Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), votesFor(ctx, repo).read()]),
	);
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const held = await t.time("claims", () => storeFor(ctx, repo, state).read());
	const claims = await t.time("status", () =>
		Promise.all(
			held.claims.map(async (record) => {
				const c = presentClaim(record, projectBranch(state));
				const { head, approval, hosted } = await changeStatus(ctx, repo, state, async () => votes.votes, c.change, c);
				// A question stays open until a person votes on the change's commit. For a waiting role's review,
				// it closes once that role signs off.
				const asked = openFlag(votes, c.change, head);
				const flag = asked?.role && !approval.awaiting?.includes(asked.role) ? null : asked;
				const attention = flag
					? { reason: flag.reason, agent: flag.agent, at: flag.at }
					: hosted?.builder?.status === "failed"
						? {
								reason: `GitHive's builder failed${hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : ""}`,
								agent: "githive-builder",
								at: c.active,
							}
						: null;
				// Dependencies not yet merged into the branch this change lands on.
				const into = c.into ?? projectBranch(state);
				const waitsOn = (c.after ?? []).filter(
					(dep) =>
						!held.released.some((r) => r.change === dep && r.mergedAs && (r.into ?? projectBranch(state)) === into),
				);
				return {
					...c,
					head,
					approval,
					...(hosted ? { hosted } : {}),
					...(attention ? { attention } : {}),
					...(waitsOn.length ? { waitsOn } : {}),
				};
			}),
		),
	);
	const waiting = claims.filter((c) => c.attention);
	await ctx
		.summarize?.(repo, {
			open: claims.length,
			needsYou: waiting.length,
			waiting: waiting.slice(0, 20).map((c) => ({
				change: c.change,
				title: c.intent.split("\n")[0].slice(0, 120),
				reason: c.attention!.reason.slice(0, 500),
			})),
			countedAt: new Date().toISOString(),
		})
		.catch(() => undefined);
	return {
		repo,
		/** The project's branch, which changes merge into by default. */
		branch: projectBranch(state),
		skipChecks: state.skipChecks ?? DEFAULT_SKIP_CHECKS,
		...(state.branchRules?.length ? { branchRules: state.branchRules } : {}),
		/** Other branches that changes land on, and where each started. */
		branches: Object.entries(state.branches ?? {}).map(([name, b]) => ({
			name,
			base: b.base,
			...(b.from ? { from: b.from } : {}),
			at: b.at,
		})),
		policy: state.policy ?? DEFAULT_POLICY,
		verify: state.verify ?? [],
		/** Whether records and merges are stamped with verified identity. */
		verified: !!state.stampKey,
		/** Per-path shard depth for claims (absent: one registry); `sharding` says since when and why. */
		...(state.shardDepth ? { shardDepth: state.shardDepth } : {}),
		sharding: shardingOf(state).sharding,
		/** "never" (one record), "on demand" (buckets once the load calls for them), or bucketed since `since`. */
		votesSharding: votes.sharded ?? (state.autoShard || state.shardDepth ? "on demand" : "never"),
		claims,
		votes: votes.votes.slice(-20).reverse(),
	};
}

// Tools that write records, after which the repo's summary notes the activity.
const WRITES = new Set([
	"claim",
	"release",
	"merge",
	"vote",
	"build",
	"revert",
	"ask_human",
	"check",
	"add_work",
	"settings",
]);
const noted = new Map<string, number>();

/** Runs one tool and notes any write in the repo's summary. */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const result = await withNews(name, args, ctx, await runTool(name, args, ctx));
	if (WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false)
		await ctx.ping?.(requiredString(args, "repo")).catch(() => undefined);
	if (ctx.summarize && WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false) {
		const repo = requiredString(args, "repo");
		const merged = name === "merge";
		// Activity alone is noted at most every 10 seconds per repo, so a busy repo doesn't queue on the index.
		if (merged || Date.now() - (noted.get(repo) ?? 0) > 10_000) {
			noted.set(repo, Date.now());
			await ctx
				.summarize(repo, { lastActivity: new Date().toISOString(), ...(merged ? { mergedBy: 1 } : {}) })
				.catch((err) => console.error(`summarizing ${repo} failed`, String(err)));
		}
		// Refresh the summary's waiting list now, so the question reaches people's inboxes at once.
		if (name === "ask_human")
			await repoSnapshot(ctx, repo).catch((err) => console.error(`updating ${repo}'s inbox failed`, String(err)));
	}
	return result;
}

/**
 * Adds what landed on the project's branch since this agent was last told, so it hears of main moving
 * without asking. Only for object replies to a named agent, and it never fails the call.
 */
async function withNews(name: string, args: Args, ctx: ToolContext, result: unknown) {
	const agent = ctx.agent ?? (typeof args.agent === "string" ? args.agent : undefined);
	if (!ctx.news || !agent || name === "register" || !result || typeof result !== "object" || Array.isArray(result))
		return result;
	const repo = requiredString(args, "repo");
	const registry = await recordLog<Registry>(ctx, repo, claimsRef(repo))
		.read()
		.catch(() => null);
	if (!registry?.commit.state.baseline) return result;
	const news = await ctx.news(repo, projectBranch(registry.commit.state), agent).catch(() => []);
	return news.length
		? {
				...(result as Record<string, unknown>),
				news: news.map((n) => ({
					...n,
					says: `${projectBranch(registry.commit.state)} changed ${n.files.join(", ")}${n.filesMore ? ` and ${n.filesMore} more` : ""}: ${n.change} by ${n.agent}${n.intent ? `, "${n.intent}"` : ""}`,
				})),
			}
		: result;
}

/** The number of claims in force, for the repo list; null before GitHive starts on the repo. */
export async function openCount(ctx: ToolContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}

async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	// The claims tool is advice, so it's served from the cached copy without reading the registry:
	// every call reading the project repo is what overloads a busy one.
	if (name === "claims" && ctx.keptClaims) return (await ctx.keptClaims(repo, () => advice(ctx, repo))).claims;
	const write = () => ctx.remote(repo, "write");
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const votes = votesFor(ctx, repo);
	// Read once per call. Only settings, when it starts GitHive, reads it again after writing it.
	const rootHead = await claims.read();
	const registered = rootHead?.commit.state;
	const key = ctx.agentKey ?? (typeof args.agent_key === "string" ? args.agent_key : undefined);
	// A signed-in agent is who its token says; otherwise an agent key names the agent.
	const acting = ctx.agent ?? (key ? await keyAgent(registered, key) : undefined);
	// A signed-in agent may leave its name out.
	const agentArg = (field: string) =>
		ctx.agent && !(typeof args[field] === "string" && args[field].trim()) ? ctx.agent : requiredString(args, field);
	const actAs = (field: string) => {
		const agent = agentArg(field);
		mayActAs(agent, acting, registered, ctx.hosted);
		return agent;
	};
	const stamper = await ctx.stamper?.(acting);
	const store = storeFor(ctx, repo, registered, { log: claims, head: rootHead });
	// Changes land on the project's branch unless their claim names another with `into`.
	const branch = projectBranch(registered);
	const present = <C extends ClaimRecord>(c: C) => presentClaim(c, branch);
	let viewing: ReturnType<ClaimStore["read"]> | undefined;
	const view = () => (viewing ??= store.read().then((v) => ({ ...v, claims: v.claims.map(present) })));
	const adviceView = async (): Promise<ClaimsAdvice> => {
		const read = async () => {
			const v = await view();
			return { claims: v.claims, merged: v.released.filter((r) => r.mergedAs).map((r) => r.change) };
		};
		return ctx.keptClaims ? ctx.keptClaims(repo, read) : read();
	};
	const changes = new Map<string, ReturnType<ClaimStore["readChange"]>>();
	const changeOf = (change: string) => {
		if (!changes.has(change))
			changes.set(
				change,
				store.readChange(change).then((c) => (c.claim ? { ...c, claim: present(c.claim) } : c)),
			);
		return changes.get(change)!;
	};
	const claimOf = async (change: string) => (await changeOf(change)).claim;
	// Each dependency in `after` not yet merged into `into`, described for the agent.
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
	// Null when nothing is pushed (no fork, or no branch on it); undefined when the read failed,
	// which says nothing either way.
	const pushedHead = (claim: ClaimRecord) =>
		changeHead(ctx, repo, claim.agent, claim.change, claim.since).catch((err): null | undefined =>
			statusOf(err).status === 409 ? null : undefined,
		);
	// Open changes' pushed heads: the caller's own (`fresh`) read now, the rest as last seen (see knownHeads).
	// Reading every fork on every call dominated GitHive's Git traffic, so a call reads only a few stale
	// heads, least recently seen first. Without knownHeads, all are read.
	const openHeads = async (claims: ClaimRecord[], fresh: (claim: ClaimRecord) => boolean = () => false) => {
		const known = ctx.knownHeads
			? await ctx
					.knownHeads(
						repo,
						claims.map((c) => ({ change: c.change, agent: c.agent })),
					)
					.catch(() => undefined)
			: undefined;
		const now = Date.now();
		const seenAt = (c: ClaimRecord) => known?.[c.change]?.at ?? 0;
		const current = (c: ClaimRecord) => now - seenAt(c) <= (known?.[c.change]?.pushed ? HEAD_PUSHED_MS : HEAD_SEEN_MS);
		const due = claims.filter((c) => !fresh(c) && !current(c)).sort((a, b) => seenAt(a) - seenAt(b));
		const reading = known ? [...claims.filter(fresh), ...due.slice(0, HEADS_READ_A_CALL)] : claims;
		const read = new Map(
			await atMost(HEAD_READS_AT_ONCE, reading, async (c) => [c.change, await pushedHead(c)] as const),
		);
		const seen = Object.fromEntries([...read].filter((r): r is [string, string | null] => r[1] !== undefined));
		// Timestamped when the reads began, so a push event since then wins.
		if (Object.keys(seen).length) await ctx.noteHeads?.(repo, seen, now).catch(() => undefined);
		return (claim: ClaimRecord) => read.get(claim.change) ?? known?.[claim.change]?.head ?? null;
	};
	// The repo's open work as `agent` sees it, for reviews and backlog. A change that landed at its current
	// head counts as merged even before its claim is released, so nobody is offered it to merge again.
	const openWork = async (agent: string) => {
		const [inForce, cast, backlog, landing] = await Promise.all([
			adviceView(),
			votes.read(),
			recordLog<Work>(ctx, repo, workRef(repo)).read(),
			ctx
				.landing?.(repo, branch)
				.view()
				.catch(() => null) ?? null,
		]);
		const heads = await openHeads(inForce.claims, (c) => c.agent === agent);
		const landedNow = new Set(
			(landing?.recent ?? []).filter((s) => s.how === "landed").map((s) => `${s.change} ${s.head}`),
		);
		const landedHere = (claim: ClaimRecord) => !claim.into && landedNow.has(`${claim.change} ${heads(claim)}`);
		const open = inForce.claims.filter((claim) => !landedHere(claim)).map((claim) => ({ claim, head: heads(claim) }));
		const counted = await countedVotes(cast.votes, registered?.stampKey);
		const teams = (await ctx.teamsOf?.(repo)) ?? [];
		return {
			agent,
			...(stamper?.by ? { by: stamper.by } : {}),
			...(teams.length ? { teams } : {}),
			policy: registered?.policy ?? DEFAULT_POLICY,
			// Each change's policy comes from the branch it lands on.
			policyOf: (claim: ClaimRecord) => branchSettings(registered, claim.into).policy,
			open,
			votes: counted,
			merged: new Set([...inForce.merged, ...inForce.claims.filter(landedHere).map((c) => c.change)]),
			work: backlog?.commit.state.items ?? [],
			abandoned: new Set(
				open
					.filter(
						(o) =>
							abandoned(
								changeSigns({
									claim: o.claim,
									head: o.head,
									counted,
									record: cast,
									landing: o.claim.into ? null : landing,
									policy: branchSettings(registered, o.claim.into).policy,
								}),
								Date.now(),
							).abandoned,
					)
					.map((o) => o.claim.change),
			),
		};
	};
	// Warm the repo's Gate ahead of a likely merge: for its checks, or without any, for its landing.
	const warmChecks = async (expect: "claimed" | "checked" | "approved", key: string) => {
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
	switch (name) {
		case "settings": {
			if (!registered?.baseline) {
				// The first settings start GitHive on the repo: policy, checks, and how claims are kept.
				const policy = policyFrom(args, DEFAULT_POLICY);
				const verify = args.verify === undefined ? [] : checksFrom(args.verify);
				// Claims stay in one record until the load calls for shards, unless shard_depth says otherwise.
				const asked = typeof args.shard_depth === "number" ? Math.max(0, Math.floor(args.shard_depth)) : undefined;
				// Sharded claims are spread over records repos when this deployment can make them.
				const wanted =
					typeof args.records_repos === "number" ? Math.max(0, Math.floor(args.records_repos)) : DEFAULT_RECORDS_REPOS;
				const spread = ctx.recordsRemote && ctx.createRecordsRepos ? wanted : 0;
				const recordsRepos = asked ? spread : 0;
				if (recordsRepos) await ctx.createRecordsRepos!(repo, recordsRepos);
				// Changes merge into the repo's default branch, whatever it's called.
				const into = registered?.branch ?? (!ctx.defaultBranch ? "main" : await ctx.defaultBranch(repo));
				const sharding = asked
					? { shardDepth: asked, recordsRepos }
					: asked === 0
						? {}
						: { autoShard: { depth: DEFAULT_SHARD_DEPTH, recordsRepos: spread } };
				await startRepo(claims, {
					baseline: await ctx.head(repo, into),
					branch: into,
					policy,
					verify,
					stampKey: stamper?.publicKey,
					...sharding,
				});
				await ctx.register?.(repo);
				// Start making seed forks now, one at a time, so agents' forks can be copied from them later.
				await ctx.prepareForks?.(repo, "seeds").catch(() => undefined);
				const registry = (await claims.read())?.commit.state;
				// With checks, warm the Gate now so its install is done and snapshotted before the first merge.
				// Without checks, the first claim warms it instead, so a repo nobody works in costs nothing.
				if (containerChecks(registry?.verify).length)
					await ctx
						.warmChecks?.(repo, {
							branch: projectBranch(registry),
							checks: containerChecks(registry?.verify),
							expect: "set up",
						})
						.catch(() => undefined);
				const warnings = grantWarnings(registry?.policy ?? policy);
				const started = {
					repo,
					branch: projectBranch(registry),
					policy: registry?.policy ?? policy,
					verify: registry?.verify ?? [],
					...shardingOf(registry),
					...(warnings.length ? { warnings } : {}),
					instructions: INSTRUCTIONS,
				};
				// Starting doesn't set branch rules, skipped files or GitHub: apply those with a second settings call.
				const rest = (["branch_rules", "skip_checks", "github"] as const).filter((f) => args[f] !== undefined);
				if (!rest.length) return started;
				const more = (await runTool(
					"settings",
					{
						repo,
						...(args.agent_key !== undefined ? { agent_key: args.agent_key } : {}),
						...Object.fromEntries(rest.map((f) => [f, args[f]])),
					},
					ctx,
				)) as Record<string, unknown>;
				return { ...started, ...more, instructions: INSTRUCTIONS };
			}
			if (args.shard_depth !== undefined || args.records_repos !== undefined)
				throw new Error(
					"[409] how claims are kept is set when GitHive starts on a repo: since, they shard as the load calls for it",
				);
			const policy = POLICY_FIELDS.some((f) => args[f] !== undefined)
				? policyFrom(args, registered.policy ?? DEFAULT_POLICY)
				: undefined;
			const verify = args.verify === undefined ? undefined : checksFrom(args.verify);
			const branchRules =
				args.branch_rules === undefined
					? undefined
					: branchRulesFrom(args.branch_rules, registered.policy ?? DEFAULT_POLICY);
			const skipChecks = args.skip_checks === undefined ? undefined : skipPatternsFrom(args.skip_checks);
			const github = args.github === undefined ? undefined : await githubFrom(ctx, args.github);
			if (!policy && !verify && !branchRules && !skipChecks && github === undefined)
				throw new Error(
					`[400] GitHive has started on ${repo}: name what to change: ${[...POLICY_FIELDS, "verify", "branch_rules", "skip_checks", "github"].join(", ")}`,
				);
			// Checks on Actions need the GitHub repo they run in.
			if (onActions(verify ?? registered.verify) && !(github ?? (github === null ? null : registered.github)))
				throw new Error(`[409] checks on GitHub Actions need a connected GitHub repo: set github ("owner/name") too`);
			await changeSettings(claims, {
				...(policy ? { policy } : {}),
				...(verify ? { verify } : {}),
				...(branchRules ? { branchRules } : {}),
				...(skipChecks ? { skipChecks } : {}),
				...(github !== undefined ? { github } : {}),
				...(stamper?.by ? { by: stamper.by } : {}),
			});
			const registry = (await claims.read())?.commit.state;
			// New checks may need new installs, so warm the Gate for them.
			if (verify)
				await ctx
					.warmChecks?.(repo, { branch: projectBranch(registry), checks: containerChecks(verify), expect: "set up" })
					.catch(() => undefined);
			const warnings = grantWarnings(registry?.policy ?? DEFAULT_POLICY);
			return {
				repo,
				branch: projectBranch(registry),
				policy: registry?.policy ?? DEFAULT_POLICY,
				verify: registry?.verify ?? [],
				skipChecks: registry?.skipChecks ?? DEFAULT_SKIP_CHECKS,
				...(registry?.branchRules?.length ? { branchRules: registry.branchRules } : {}),
				...(registry?.github ? { github: registry.github.repo } : {}),
				...(warnings.length ? { warnings } : {}),
			};
		}
		case "reviews": {
			const agent = actAs("agent");
			const state = await openWork(agent);
			const held = ctx.reviews ? await ctx.reviews.held(repo).catch(() => ({})) : {};
			// Tell people about blocking-role reviews that waited too long. It runs when someone looks; no timer.
			if (ctx.reviews)
				await tellPeopleOfWaitingRoles(
					ctx,
					repo,
					votes,
					registered?.policy ?? DEFAULT_POLICY,
					state.open,
					state.votes,
					(claim) => branchSettings(registered, claim.into).policy,
				).catch((err) => console.error(`checking ${repo}'s waiting reviews failed`, String(err)));
			const options = reviewsFor({ ...state, held });
			return {
				reviews: options.slice(0, LISTED_AT_MOST),
				...(options.length > LISTED_AT_MOST ? { more: options.length - LISTED_AT_MOST } : {}),
			};
		}
		case "backlog": {
			const { open, waiting } = backlogFor(await openWork(actAs("agent")));
			return {
				open: open.slice(0, LISTED_AT_MOST),
				...(open.length > LISTED_AT_MOST ? { more: open.length - LISTED_AT_MOST } : {}),
				waiting: waiting.slice(0, LISTED_AT_MOST),
				...(waiting.length > LISTED_AT_MOST ? { moreWaiting: waiting.length - LISTED_AT_MOST } : {}),
			};
		}
		case "add_work": {
			const by = actAs("agent");
			if (args.items !== undefined) {
				if (!Array.isArray(args.items) || !args.items.length || args.items.length > MOST_AT_ONCE)
					throw new Error(`[400] items is a list of 1 to ${MOST_AT_ONCE} pieces of work`);
				const items = args.items.map((item) => workItemFrom(item as Record<string, unknown>));
				const ids = items.map((i) => i.id);
				const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
				if (twice.length)
					throw new Error(`[400] each piece needs its own id: ${[...new Set(twice)].join(", ")} more than once`);
				const added = await addWorks(recordLog<Work>(ctx, repo, workRef(repo)), by, items);
				return { ok: added.ok, added: added.added, ...(added.already.length ? { already: added.already } : {}) };
			}
			const item = workItemFrom(args);
			const added = await addWork(recordLog<Work>(ctx, repo, workRef(repo)), { ...item, by });
			return added.ok ? { ok: true, id: item.id } : { ok: false, reason: added.refused };
		}
		case "review_access": {
			// Anyone may review, with read-only access to the change's branch in its author's fork.
			const change = requiredString(args, "change");
			const { claim: held, released } = await changeOf(change);
			const author = held?.agent ?? released.at(-1)?.agent;
			if (!author) throw new Error(`[404] no change ${change} on ${repo}`);
			const [fork, project] = await Promise.all([
				changeSource(author, "read", change, held?.since),
				ctx.remote(repo, "read"),
			]);
			const head = await branchHead(fork, `changes/${change}`).catch(() => null);
			if (!head) throw new Error(`[409] ${change} has nothing pushed to review yet`);
			// Agent names only: a person's identity stays in the records, out of logs.
			console.log(`review access to ${repo} ${change} (${author}) for ${acting ?? "an unregistered caller"}`);
			const into = (await claimOf(change))?.into ?? branch;
			// Mark this commit and role as under review, so others see it taken. The mark binds nobody
			// and goes when the reviewer votes, or after 15 minutes.
			const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : "review";
			const reviewer = acting ?? (typeof args.agent === "string" ? args.agent : undefined);
			if (reviewer)
				await ctx.reviews?.hold(repo, holdKey(head, role), reviewer, Number.POSITIVE_INFINITY).catch(() => undefined);
			return {
				change,
				author,
				url: fork.url,
				token: fork.token,
				branch: `changes/${change}`,
				head,
				role,
				project: { url: project.url, token: project.token, branch: into },
				...(into !== branch ? { into } : {}),
			};
		}
		case "credentials": {
			if (typeof args.change !== "string" || !args.change.trim()) {
				const remote = await ctx.remote(repo, "read");
				return {
					url: remote.url,
					token: remote.token,
					note: "read-only: the project repo is written only through the toolkit. Ask with your change for write access to its fork.",
				};
			}
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			if (!own) throw new Error(`[409] ${change} holds no claim: claim its paths first`);
			mayActAs(own.agent, acting, registered, ctx.hosted);
			// One fork serves all the agent's changes. Its default branch may lag the project's, so a new change
			// starts from the project's branch, which `project` gives read access to.
			const [remote, project] = await Promise.all([changeSource(own.agent, "write"), ctx.remote(repo, "read")]);
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
			// With `source`, the change merges a whole branch, claiming what it changed (see branchMerge).
			const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
			const given = source ? [] : normalizeClaim(requiredPaths(args, "paths"));
			const reserved = given.find(isReservedPath);
			if (reserved) throw new Error(`[400] ${reserved}: a path can't start with "::"`);
			// A change lands on one branch: claiming again keeps it there, and naming another is refused.
			const held = await claimOf(change);
			const asked = typeof args.into === "string" && args.into.trim() ? args.into.trim() : undefined;
			const into = asked ?? held?.into ?? branch;
			if (held && (held.into ?? branch) !== into)
				throw new Error(
					`[409] ${change} lands on ${held.into ?? branch}: a change lands on one branch; claim another change for ${into}`,
				);
			const made =
				into === branch || held
					? undefined
					: await targetBranch(ctx, repo, {
							into,
							from: typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined,
							registered,
							claims,
							agent,
							stamper,
						});
			const merging = source ? await branchMerge(ctx, repo, source, into) : undefined;
			const paths = merging ? merging.paths : given;
			const after = changeList(args.after, "after");
			if (after.includes(change)) throw new Error(`[400] ${change} can't wait on itself`);
			// Refuse a dependency loop, which would leave every change in it waiting forever.
			const loop = after.length
				? await dependencyLoop(change, after, async (dep) => (await claimOf(dep))?.after ?? [])
				: undefined;
			if (loop)
				throw new Error(`[409] after ${loop.at(1)}, ${change} would wait on itself: ${loop.join(" waits on ")}`);
			const input = {
				change,
				agent,
				paths: scopePaths(paths, into, branch),
				intent: requiredString(args, "intent"),
				...(after.length ? { after } : {}),
				...(source ? { source } : {}),
				staleAfterMs: STALE_AFTER_MS,
				abandoned: abandonedRule(ctx, repo, registered, votes),
			};
			// If one record would hold agents up, shard first, then claim in the shards.
			const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
			const outcome = await (sharded ? storeFor(ctx, repo, sharded) : store).claim(input, stamper);
			// Report conflicting paths as agents wrote them, without the branch scoping.
			const conflicts = outcome.ok
				? undefined
				: outcome.conflicts.map((c) => ({
						...c,
						path: presentClaim({ paths: [c.path] }, branch).paths[0],
						held: presentClaim({ paths: [c.held] }, branch).paths[0],
					}));
			// Once claimed, the source's tip becomes the change's branch in the agent's fork.
			if (outcome.ok && merging) await merging.push(await changeSource(agent, "write"), change);
			// Without container checks, the Gate lands the change within minutes, so warm it from the claim. A cold
			// Gate holds up the first batch. With checks, a claim is too early to install for; they warm at the check.
			if (outcome.ok && !containerChecks(registered?.verify).length) await warmChecks("claimed", change);
			const merged = merging
				? {
						source,
						head: merging.tip,
						claimed: paths,
						note: `${change} merges ${source} at ${merging.tip.slice(0, 8)} into ${into}: its branch changes/${change} is that commit, in your fork. Get it reviewed, check and merge it like any change. If ${source} moves on, claim again to bring the change up to its new tip (a new head, so a new review).`,
					}
				: {};
			// A refused claim that couldn't be fully backed out still holds paths: releasing the change frees them.
			const stuck =
				!outcome.ok && outcome.stillHeld?.length
					? {
							note: `part of ${change}'s claim couldn't be undone and still holds paths (${outcome.stillHeld.length} record(s)): release ${change} to free them`,
						}
					: {};
			return {
				...outcome,
				...(conflicts ? { conflicts } : {}),
				...(into !== branch ? { into } : {}),
				...(made ? { branch: made } : {}),
				...merged,
				...stuck,
			};
		}
		case "release": {
			const change = requiredString(args, "change");
			const agent = actAs("agent");
			// Only a claim's agent may release it; anyone else may release it only as stale, once abandoned.
			const held = args.stale === true ? null : await claimOf(change);
			if (held && held.agent !== agent)
				throw new Error(
					`[403] ${change} is ${held.agent}'s claim: only its agent releases it, or anyone once it's abandoned (release with stale: true)`,
				);
			if (args.stale === true)
				return store.releaseStale(
					{ change, agent, staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) },
					stamper,
				);
			return store.release(
				{ change, agent, reason: typeof args.reason === "string" ? args.reason : "released" },
				stamper,
			);
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
			// If one record would hold reviewers up, shard the votes first.
			const commit = requiredString(args, "commit");
			const teams = (await ctx.teamsOf?.(repo)) ?? [];
			const cast = await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote(
				{
					commit,
					reviewer,
					role: requiredString(args, "role"),
					verdict,
					evidence: requiredString(args, "evidence"),
					...(teams.length ? { teams } : {}),
				},
				stamper,
			);
			// The review is done, so drop the hold review_access placed.
			await ctx.reviews?.release(repo, holdKey(commit, requiredString(args, "role")), reviewer).catch(() => undefined);
			if (verdict === "approve") await warmChecks("approved", commit);
			return cast;
		}
		case "merge": {
			// mergeChange reads the claims again itself, when it checks them.
			const registry = registered;
			// Anyone may merge a change whose conventions hold. It merges as its agent; the stamp says who asked.
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			const holder = own?.agent;
			if (holder && holder !== agentArg("agent"))
				throw new Error(`[409] ${change} is ${holder}'s change: merge it as ${holder}`);
			// It lands on the branch its claim names, together with every other change ready there.
			const into = own?.into ?? branch;
			// Not before its dependencies have merged into that same branch.
			const waits = await waitingOn(own?.after ?? [], into);
			if (waits.length) return { ok: false, reasons: waits };
			// A repo connected to GitHub may run its checks on Actions, and gets main pushed back after each landing.
			const checksHere = branchSettings(registry, into).verify;
			const link =
				registry?.github && ctx.github
					? await ctx
							.github(registry.github.repo)
							.catch((err) => (console.error(`reaching ${registry.github!.repo} on GitHub failed`, String(err)), null))
					: null;
			if (onActions(checksHere) && !link)
				return {
					ok: false,
					reasons: [
						`checks run on GitHub Actions, but ${registry?.github ? `GitHive can't reach ${registry.github.repo}: is the GitHive app installed there?` : "no GitHub repo is connected (settings github)"}`,
					],
				};
			const project = await write();
			// The repo's Gate (a container running real git) lands every batch and does its GitHub pushes. Changes are
			// read through Artifacts' API here; the Gate reads only those it can't place (see artifactsInspect).
			const gate = ctx.batchGit
				? ctx.batchGit(repo)
				: fail(503, "GitHive can't land changes here: no Gate is set up to land them");
			const batchGit = ctx.history ? { ...gate, inspect: artifactsInspect(ctx.history, repo, gate.inspect) } : gate;
			return mergeChange({
				remote: project,
				branch: into,
				...(into !== branch ? { scope: (file: string) => scopeFile(file, into, branch) } : {}),
				store,
				votes,
				policy: branchSettings(registry, into).policy,
				verify: branchSettings(registry, into).verify,
				...(registry?.skipChecks ? { skipChecks: registry.skipChecks } : {}),
				runChecks: onActions(checksHere) && link ? actionsChecks(gate, link) : ctx.runChecks?.(repo),
				...(ctx.branchHead ? { branchHead: () => ctx.branchHead!(repo, into) } : {}),
				...(ctx.landing ? { landing: ctx.landing(repo, into) } : {}),
				batchGit,
				...(ctx.history ? { history: ctx.history } : {}),
				...(ctx.prepareLanding ? { prepareLanding: () => ctx.prepareLanding!(repo) } : {}),
				...(ctx.prepareChecks && !onActions(checksHere) ? { prepareChecks: ctx.prepareChecks(repo) } : {}),
				// Push the landed branch back to GitHub as a fast-forward, refused if someone pushed there directly.
				...(link && into === branch ? { afterLanding: (commit: string) => mirrorTo(gate, link, into, commit) } : {}),
				// Other changes ready for this branch, from the cached advice: claims in force whose dependencies
				// have merged. The batch checks each again before landing.
				others: async (): Promise<Candidate[]> => {
					const inForce = await adviceView();
					const merged = new Set(inForce.merged);
					const sameBranch = inForce.claims.filter(
						(c) =>
							(c.into ?? branch) === into && c.change !== change && (c.after ?? []).every((dep) => merged.has(dep)),
					);
					const heads = await openHeads(inForce.claims);
					return sameBranch.map((claim) => ({
						claim,
						head: heads(claim),
						source: () => changeSource(claim.agent, "read", claim.change, claim.since),
					}));
				},
				stamper,
				stampKey: registry?.stampKey,
				source: await changeSource(holder ?? agentArg("agent"), "read", change, own?.since),
				change,
				agent: agentArg("agent"),
			});
		}
		case "build": {
			if (!ctx.startBuilder) throw new Error("[501] hosted builders aren't available here");
			if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
				throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
			const intent = requiredString(args, "intent");
			const change = changeId(intent);
			const claimed = await store.claim(
				{
					change,
					agent: "githive-builder",
					paths: normalizeClaim(requiredPaths(args, "paths")),
					intent,
					staleAfterMs: STALE_AFTER_MS,
					abandoned: abandonedRule(ctx, repo, registered, votes),
				},
				stamper,
			);
			if (!claimed.ok) return claimed;
			return ctx.startBuilder({ repo, change });
		}
		case "request_review": {
			if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
				throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
			const change = requiredString(args, "change");
			const registry = registered;
			if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim: claim the change's paths first`);
			if (!ctx.requestReview) throw new Error("[501] hosted reviewers aren't available here");
			const policy = branchSettings(registry, (await claimOf(change))?.into).policy;
			// By default a general review, and every role that can veto a change to these paths.
			const roles =
				Array.isArray(args.roles) && args.roles.length
					? (args.roles as string[])
					: hostedRoles(effectivePolicy(policy, (await claimOf(change))?.paths ?? []).vetoes);
			return ctx.requestReview({
				repo,
				change,
				roles,
				...(typeof args.summary === "string" ? { summary: args.summary } : {}),
			});
		}
		case "audit": {
			const { merges, violations } = await runAudit(ctx, repo);
			return { merges, open: violations.filter((v) => !v.resolvedBy).length, violations };
		}
		case "revert": {
			const { violations } = await runAudit(ctx, repo);
			return revertViolation({
				remote: await write(),
				branch: projectBranch(registered),
				claims,
				votes,
				stamper,
				target: requiredString(args, "commit"),
				violations,
				agent: actAs("agent"),
			});
		}
		case "status": {
			const change = requiredString(args, "change");
			const held = (await claimOf(change)) ?? null;
			const released = held ? undefined : (await changeOf(change)).released.at(-1);
			const votesOn = async (head: string) => (await votes.readFor([head])).votes;
			const waits = held?.after?.length ? await waitingOn(held.after, held.into ?? branch) : [];
			const status = await changeStatus(
				ctx,
				repo,
				registered,
				votesOn,
				change,
				held ?? undefined,
				held?.agent ?? released?.agent,
			);
			// A change can land before its claim is released (that waits for the lease to be handed on).
			// Report it, so its agent doesn't try to merge it again.
			const landed =
				held && status.head
					? (
							await ctx
								.landing?.(repo, held.into ?? branch)
								.view()
								.catch(() => null)
						)?.recent.findLast((s) => s.change === change && s.head === status.head && s.how === "landed")
					: undefined;
			return {
				change,
				claim: held,
				...(released ? { released } : {}),
				...(landed ? { landed: { commit: landed.commit, at: landed.at } } : {}),
				...(waits.length ? { waitsOn: waits } : {}),
				...status,
			};
		}
		case "check": {
			const change = requiredString(args, "change");
			const own = await claimOf(change);
			const source = own ? await changeSource(own.agent, "read", change, own.since).catch(() => null) : null;
			if (!source) throw new Error(`[409] changes/${change} has nothing pushed to check`);
			const into = own?.into ?? branch;
			const checked = await checkChange({
				project: await ctx.remote(repo, "read"),
				branch: into,
				source,
				claims: own ? [own] : [],
				change,
				...(ctx.branchHead ? { branchHead: () => ctx.branchHead!(repo, into) } : {}),
				...(ctx.history ? { history: ctx.history } : {}),
			});
			// On a conflict, name who last changed each file, as the landing remembers it.
			const conflicting = checked.main.clean ? [] : (checked.main.conflicts ?? []);
			const causes =
				conflicting.length && ctx.landing
					? lastLandedOn(
							(
								await ctx
									.landing(repo, into)
									.view()
									.catch(() => null)
							)?.recent ?? [],
							conflicting,
						)
					: [];
			// Agents check after each push, so note this head for reviews, backlog and merge (see openHeads).
			await ctx.noteHeads?.(repo, { [change]: checked.head }).catch(() => undefined);
			// A merge is likely within minutes of a check, so warm the check container now.
			await warmChecks("checked", change);
			return causes.length ? { ...checked, causes } : checked;
		}
		case "register": {
			if (ctx.agent)
				throw new Error(
					`[409] you're signed in as ${ctx.agent}: what you write is already attributed to you, with no key`,
				);
			const nameOk = (agent: string) => {
				if (agent.includes("/"))
					throw new Error(
						'[400] names with "/" are signed-in agents\' (<handle>/<agent>); register a name without one',
					);
				if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted)
					throw new Error("[403] githive- names are GitHive's hosted agents'");
				return agent;
			};
			const keyFor = (agent: string) =>
				`${agent}.${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
					.replace(/\+/g, "-")
					.replace(/\//g, "_")
					.replace(/=+$/, "")}`;
			const note =
				"Keep each key secret; it is shown once. Send it as X-GitHive-Agent-Key (or agent_key) with every call.";
			if (args.agents !== undefined) {
				if (!Array.isArray(args.agents) || !args.agents.length || args.agents.length > MOST_AT_ONCE)
					throw new Error(`[400] agents is a list of 1 to ${MOST_AT_ONCE} names`);
				const names = args.agents.map((a) =>
					typeof a === "string" && a.trim() ? nameOk(a.trim()) : fail(400, "each of agents is a name"),
				);
				if (new Set(names).size !== names.length) throw new Error("[400] agents names a name more than once");
				const keys = names.map(keyFor);
				const outcome = await registerAgents(
					claims,
					await Promise.all(names.map(async (agent, i) => ({ agent, keyHash: await sha256(keys[i]) }))),
					stamper,
				);
				if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
				await ctx.prepareForks?.(repo, names).catch(() => undefined);
				return { agents: names.map((agent, i) => ({ agent, key: keys[i] })), note };
			}
			const agent = nameOk(requiredString(args, "agent"));
			const newKey = keyFor(agent);
			const outcome = await registerAgent(
				claims,
				{ agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) },
				stamper,
			);
			if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
			// Queue its fork now, rather than making it on its first push alongside everyone else's.
			await ctx.prepareForks?.(repo, [agent]).catch(() => undefined);
			return { agent, key: newKey, note: note.replace("each key", "this key") };
		}
		default:
			throw new Error(`[400] unknown tool ${name}`);
	}
}
