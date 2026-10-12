import type { Level } from "./lib/permissions";
import { repoPath } from "./lib/repoName";
import type { Summaries } from "./lib/repos";

// The dashboard's calls to the Worker.

/** How changes merge, as the settings tool takes it. Fields left out stay as they are. */
export interface SettingsInput {
	required?: number;
	vetoes?: string[];
	escalate?: { paths: string[]; required?: number; vetoes?: string[] }[];
	grants?: Record<string, string[]>;
	verify?: string[];
	/** Paths the checks skip, as patterns like *.md or docs/. An empty list skips nothing. */
	skip_checks?: string[];
	/** Settings for other branches, by pattern. Each rule changes only what it sets; an empty list clears them. */
	branch_rules?: {
		pattern: string;
		required?: number;
		vetoes?: string[];
		grants?: Record<string, string[]>;
		verify?: string[];
	}[];
	/** The connected GitHub repo, "owner/name", or "" for none. */
	github?: string;
	/** How GitHive's work reaches GitHub: through a pull request, or pushed to its main. */
	github_sync?: GitHubSync;
	/** Whether GitHub's changes come back without review. */
	github_trust?: boolean;
}

export type GitHubSync = "mirror" | "pr";

/** A repo's link to GitHub, as the snapshot shows it (newer servers, connected repos only). */
export interface RepoGitHub {
	repo: string;
	sync: GitHubSync;
	trust: boolean;
	/** Whether GitHub's changes come back: not for a link made before modes, which only mirrors until one is set. */
	inbound: boolean;
	/** The standing pull request as GitHive last saw it: open then, it may have been merged since. */
	pull: { number: number; url: string } | null;
	/** Bringing GitHub's changes back, as GitHive last did it. */
	fromGitHub?: {
		step: "import" | "claim" | "merge" | "done" | "waiting" | "needs a person" | "given up" | "failed";
		commit: string;
		at: string;
		change?: string;
		reason?: string;
	};
}

/** What giving up GitHub's change answers: released, or why not. */
export interface GiveUpAnswer {
	ok: boolean;
	released?: string;
	note?: string;
	refused?: string;
}

/** What github_pr answers: the pull request, and whether it was just opened or rewritten. */
export interface PullAnswer {
	pr: string;
	number: number;
	title: string;
	opened?: true;
	open?: true;
	refreshed?: true;
	changes?: number;
	note?: string;
}

/** A branch rule as the server stores it. Without checks of its own, the repo's apply. */
export interface BranchRule {
	pattern: string;
	policy?: Partial<RepoSnapshot["policy"]>;
	verify?: string[];
}

/** The settings after a change, and anything to know about the grants. */
export interface SavedMergeSettings {
	policy: RepoSnapshot["policy"];
	verify: string[];
	skipChecks?: string[];
	branchRules?: BranchRule[];
	warnings?: string[];
}

/** A repo, as the dashboard shows it (GET /repos/:owner/:name). */
export interface RepoSnapshot {
	repo: string;
	/**
	 * `grants` names who may vote as each role that can block a merge. A role it leaves out goes to people and
	 * GitHive's reviewers. Older servers omit it.
	 */
	policy: {
		required: number;
		vetoes: string[];
		escalate?: { paths: string[]; required?: number; vetoes?: string[] }[];
		grants?: Record<string, string[]>;
	};
	verify: string[];
	/** The project's branch, which changes merge into. Older servers omit it, meaning main. */
	branch?: string;
	/** Whether records and merges are stamped with verified identity. */
	verified: boolean;
	/** Other branches' settings by pattern (newer servers). */
	branchRules?: BranchRule[];
	/** Paths the checks skip. A change touching only these merges without checks (newer servers). */
	skipChecks?: string[];
	/** Other branches that changes land on, and where each started (newer servers). */
	branches?: { name: string; base: string; from?: string; at: string }[];
	/**
	 * How claims are stored (newer servers): in one record until the load calls for shards ("on demand"),
	 * always in one record ("never"), or sharded since `since`.
	 */
	sharding?: "on demand" | "never" | { since?: string; because?: string };
	/** How many path segments deep claims are sharded, once they are. */
	shardDepth?: number;
	/**
	 * How votes are stored (newer servers): in one record until the load calls for buckets ("on demand"),
	 * always in one record ("never"), or in buckets since `since`.
	 */
	votesSharding?: "on demand" | "never" | { since?: string; because?: string };
	claims: {
		change: string;
		agent: string;
		paths: string[];
		intent: string;
		since: string;
		active: string;
		by?: string;
		/** The change's branch head, null until something is pushed. */
		head: string | null;
		/** The branch it lands on, when not the project's (newer servers). */
		into?: string;
		/** For a change that merges a whole branch: that branch. */
		source?: string;
		/** Changes it depends on (after), and those of them not merged into its branch yet. */
		after?: string[];
		waitsOn?: string[];
		approval: {
			approved: boolean;
			approvals: number;
			required: number;
			vetoedBy: string[];
			/** Veto roles still to approve; the change merges once each has (newer servers). */ awaiting?: string[];
		};
		/** For GitHub's change while the repo trusts GitHub's changes: why it needs no review. */
		trusted?: string;
		/** A question for a person, from an agent or a failed GitHive builder. It stays until a person votes. */
		attention?: { reason: string; agent: string; at: string; urgency?: number };
		/** GitHive's hosted agents on the change. */
		hosted?: {
			builder?: { status: string; revisions: number; error?: string };
			reviewers: { role: string; status: string; verdict?: string }[];
		};
		/** How long the claim lasts if its agent goes quiet (newer servers). */
		lease?: ClaimLease;
	}[];
	votes: {
		commit: string;
		reviewer: string;
		role: string;
		verdict: "approve" | "reject";
		evidence: string;
		at: string;
		by?: string;
	}[];
	/** Loaded separately (GET /repos/:repo/audit) and less often, because it replays every record. */
	audit?: RepoAudit;
	/** The connected GitHub repo (newer servers). */
	github?: RepoGitHub;
}

/**
 * How long a claim lasts if its agent goes quiet (see the server's toolkit/staleness.ts): whose turn its change is on,
 * and on its agent's turn the time after which anyone may take its paths. Waiting on anyone else, it never frees.
 */
export interface ClaimLease {
	waitingOn: "agent" | "reviewers" | "landing" | "person";
	freeAfter?: string;
}

/**
 * What's landing on a branch (GET /repos/:repo/landing): the changes being
 * checked together now, and what changes came to lately. Approved changes
 * land as a set, checked once together, in one push.
 */
/** A repo's last stretch of work: what landed since it last went quiet (see the server's toolkit/stretch.ts). */
export interface LandingStretch {
	landed: number;
	/** Changes put out because their checks failed. */
	failed: number;
	agents: number;
	from: string;
	to: string;
}

export interface RepoLanding {
	branch: string;
	/** The repo's last stretch of work, across its branches. Older servers leave it out. */
	stretch?: LandingStretch;
	/** The batch being checked now, on `base`. */
	checking: { base: string; since: string; changes: { change: string; head: string; agent: string }[] } | null;
	/** Recently settled changes, newest last: landed as `commit`, or removed because their checks failed. */
	recent: {
		change: string;
		head: string;
		agent: string;
		how: "landed" | "failed";
		at: string;
		commit?: string;
		reasons?: string[];
	}[];
}

/** One thing an agent did in the hive (GET /repos/:repo/events), for the live feed. */
export interface HiveEvent {
	kind:
		| "claimed"
		| "released"
		| "pushed"
		| "voted"
		| "merging"
		| "landed"
		| "failed"
		| "asked"
		| "reverted"
		| "added"
		| "building"
		| "interface"
		| "heads_up"
		| "conflicted";
	/** Who did it. A push names only its change. */
	agent?: string;
	change?: string;
	commit?: string;
	verdict?: "approve" | "reject";
	/** The other agent: whose change uses an interface that changed, or the other side of a heads-up. */
	other?: string;
	/** A heads-up's other side's change: the one using the names this event's change alters. */
	otherChange?: string;
	/** The intent claimed, the role voted as, why a landing failed, the names or files an awareness event is about. */
	detail?: string;
	at: string;
}

/**
 * A piece of work in a repo's backlog, as agents see it with `backlog`: taken once a change with its id is claimed,
 * done once that change merges. The dashboard has no endpoint for it yet; the Hive tab shows it when it's given one.
 */
export interface BacklogItem {
	id: string;
	title: string;
	intent: string;
	/** What it's likely to touch. */
	paths?: string[];
	/** Items it waits for: it's free only once each has merged. */
	after?: string[];
	by: string;
	at: string;
}

/** A person's vote from the dashboard. */
export interface VoteInput {
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
}

export interface RepoAudit {
	merges: number;
	open: number;
	violations: { commit: string; author: string; rule: string; detail: string; by?: string; resolvedBy?: string }[];
}

/** A repo's files at a branch or commit (GET /repos/:repo/tree). */
export interface RepoTree {
	ref: string;
	commit: string;
	/** Every file path, sorted. */
	files: string[];
	/** The listing stopped early: a very large repo. */
	truncated: boolean;
}

/** One file at a branch or commit (GET /repos/:repo/file): its text, or why there is none. */
export interface RepoFile {
	ref: string;
	commit: string;
	path: string;
	size: number;
	text?: string;
	binary?: boolean;
	tooBig?: boolean;
}

/** A review of a landed change's head. */
export interface HistoryReview {
	reviewer: string;
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
}

/** One change landed on a branch: why it was made, and the reviews it landed with. */
export interface LandedChange {
	commit: string;
	change: string;
	agent: string;
	head: string;
	title: string;
	intent?: string;
	files: string[];
	reviews: HistoryReview[];
	at?: string;
}

/** The changes landed on a branch, newest first (GET /repos/:repo/history). */
export interface BranchHistory {
	branch: string;
	total: number;
	changes: LandedChange[];
}

/** One change's history (GET /repos/:repo/changes/:change). */
export interface ChangeHistory {
	change: string;
	branch: string;
	/** The claim in force, or null once it merged or was released. */
	claim: Omit<RepoSnapshot["claims"][number], "head" | "approval" | "hosted"> | null;
	released: { reason: string; at: string; mergedAs?: string; agent: string; stale?: boolean }[];
	/** The change's own commits, newest first. */
	commits: { commit: string; message: string; author: string; at: string }[];
	votes: RepoSnapshot["votes"];
	/** While its claim is in force: its merge check as the agent's last status worked it out (newer servers). */
	merge?: MergeCheck;
	/** Its earlier attempts to land, oldest first: conflicts and failed checks, in a line each (newer servers). */
	attempts?: string[];
	/** While its claim is in force: its footprint, and where it meets other open changes (newer servers). */
	awareness?: ChangeAwareness;
}

/** A commit on the branch that touched a conflicted file since the change left it. */
export interface TouchedBy {
	file: string;
	commit: string;
	/** A GitHive merge's change, agent and intent. */
	change?: string;
	agent?: string;
	/** The claim's intent for a GitHive merge; a plain commit's subject. */
	intent?: string;
	/** A commit pushed with plain git: its author. */
	author?: string;
}

/** Whether a change merges cleanly into its branch, worked out on `head` against the branch at `branchHead`. */
export interface MergeCheck {
	head?: string;
	into: string;
	branchHead: string;
	clean: boolean;
	conflicts?: string[];
	/** Who changed each conflicted file, newest first within each file; at most five a file. */
	touchedBy?: TouchedBy[];
	/** Each conflicted file with its conflict markers, at most 4 KB, `truncated` when cut. */
	hunks?: { file: string; content: string; truncated: boolean }[];
	/** The commands that resolve it in the agent's clone, then its next step. */
	fix?: string[];
	outsideClaim?: string[];
}

/** An exported name whose interface a change alters. */
export interface AlteredName {
	/** "loadSettings", or "Store.get" for a class member. */
	name: string;
	change: "interface" | "removed" | "no longer exported" | "now exported";
	before?: string;
	after?: string;
	default?: true;
}

/** Where a use is: a file and a line. */
export interface UseSite {
	file: string;
	line: number;
}

/** Where a change's footprint meets another open change's: one altered name, as one side uses it. */
export interface Overlap {
	file: string;
	altered: AlteredName;
	/** The name as imported where it's used ("*" for the whole file). */
	imported: string;
	/** Where it's used: in the other change (usedBy), or in this one (alteredBy). */
	at: UseSite[];
	other: { by: string; change: string; intent?: string };
}

/** A change's footprint, and where it meets the other open changes into its branch (see FootprintCache.overlapsOf). */
export interface ChangeAwareness {
	change: string;
	agent: string;
	branch: string;
	head: string;
	base: string;
	at: number;
	alters: { file: string; altered: AlteredName }[];
	uses: { file: string; name: string; at: UseSite[] }[];
	/** What it alters that other agents' open changes use. */
	usedBy: Overlap[];
	/** What it uses that other agents' open changes alter. */
	alteredBy: Overlap[];
	omitted?: Partial<Record<"alters" | "uses" | "usedBy" | "alteredBy", number>>;
}

/** Who is looking at the dashboard (GET /me). */
export type Me =
	| {
			kind: "user";
			handle: string;
			name: string | null;
			email: string;
			avatarUrl: string | null;
			by: string;
			/** Whether they may start GitHive's hosted agents (newer servers). */ hostedAgents?: boolean;
	  }
	/** Through Cloudflare Access, on the admin hostnames: no sign-in and no agents of their own. */
	| { kind: "access"; label: string; by: string; hostedAgents?: boolean }
	| { kind: "agent"; handle: string; agent: string; by: string };

/** One of your agents' tokens: its first characters only; the secret is shown once, when it is made. */
export interface AgentToken {
	id: string;
	agentId: string;
	prefix: string;
	createdAt: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/** One of your agents (GET /me/agents). Its full name is <handle>/<name>. */
export interface MyAgent {
	id: string;
	ownerId: string;
	name: string;
	createdAt: string;
	revokedAt: string | null;
	tokens: AgentToken[];
}

/** A token just made: `token` is the secret, shown this once. */
export type IssuedToken = AgentToken & { token: string };

/** An MCP client connected over OAuth, acting as one of your agents. */
export interface Connection {
	id: string;
	client: string;
	agentId: string | null;
	agent: string | null;
	createdAt: string;
}

/** A role in an org. A person's own namespace has only its owner. */
export type OrgRole = "owner" | "admin" | "member";

/** An org, or a person's own namespace (`personal`), as GET /orgs lists them, with the caller's role. */
export interface Org {
	id: string;
	slug: string;
	name: string | null;
	personal: boolean;
	defaultPermission: Level;
	membersCanCreateRepos: boolean;
}

export type MyOrg = Org & { role: OrgRole };

/** A repo record (POST /repos, GET /orgs/:org). */
export interface RepoRecord {
	id: string;
	org: string;
	name: string;
	fullName: string;
	visibility: "private" | "public";
	createdAt: string;
}

/** One org (GET /orgs/:org): its people and teams only to members, its invitations only to owners and admins. */
export interface OrgDetail extends Org {
	role: OrgRole | null;
	canCreateRepos: boolean;
	repos: RepoRecord[];
	members: { userId: string; handle: string; name: string | null; avatarUrl: string | null; role: OrgRole }[];
	teams: { id: string; slug: string; name: string | null; members: string[] }[];
	invites: { email: string; role: OrgRole; createdAt: string }[];
}

/** What the caller may do in a repo (GET /repos/:owner/:name/access). */
export interface RepoAccess {
	id: string;
	fullName: string;
	level: Level;
	visibility: "private" | "public" | null;
	/** Its default branch (newer servers), or null for a repo with no commits. */
	branch?: string | null;
}

/** A new repository: imported, copied, or empty. */
export interface NewRepoInput {
	owner: string;
	name: string;
	import_url?: string;
	/** For a private repo: a token that reads it, used once to clone it and kept nowhere. */
	import_token?: string;
	branch?: string;
	copy_from?: string;
	visibility: "private" | "public";
	/** For a fresh repo: what its first commit holds. */
	init?: { readme?: boolean; description?: string; gitignore?: Gitignore; license?: "mit" };
}

export type Gitignore = "node" | "python" | "go" | "rust";

/** Fired when the server says the session is gone, so the dashboard shows the sign-in screen again. */
export const SIGNED_OUT_EVENT = "githive:signed-out";

/** What a call that needs signing in fails with: a session ended, or someone signed out asked for a private repo. */
export const SIGNED_OUT_MESSAGE = "Your session ended: sign in to GitHive again.";

function asRecord(value: unknown): Record<string, unknown> | null {
	const isRecord = value !== null && typeof value === "object" && !Array.isArray(value);
	return isRecord ? (value as Record<string, unknown>) : null;
}

/** Why a request failed, in words: a session that ended, the server's own error, or the HTTP status. */
function failureMessage(response: Response, data: unknown): string {
	if (response.status === 401) return SIGNED_OUT_MESSAGE;
	const detail = asRecord(data)?.error;
	if (typeof detail === "string") return detail;
	return `${response.status} ${response.statusText}`;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const response = await fetch(path, { method, headers, body: payload });
	const text = await response.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// An older server without this route answers with the dashboard page, which isn't JSON.
		throw new Error(response.ok ? `Unexpected response from ${path}` : `${response.status} ${response.statusText}`);
	}
	if (!response.ok) {
		if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
		throw new Error(failureMessage(response, data));
	}
	return data as T;
}

export const api = {
	/** Every repo with its counts, for the Repositories list and the Inbox. The server keeps them, so it's one read. */
	summaries: () => call<Summaries>("GET", "/summaries"),
	snapshot: (repo: string) => call<RepoSnapshot>("GET", `/repos/${repoPath(repo)}`),
	/** The latest demo run on a repo, for its Hive tab's banner (404 unless it's the demo repo). */
	demoRun: (repo: string) => call<DemoRunStatus>("GET", `/demo/runs/${repoPath(repo)}`),
	audit: (repo: string) => call<RepoAudit>("GET", `/repos/${repoPath(repo)}/audit`),
	history: (repo: string, branch: string) =>
		call<BranchHistory>("GET", `/repos/${repoPath(repo)}/history?branch=${encodeURIComponent(branch)}`),
	/** What's landing on a branch of the repo. */
	landing: (repo: string, branch: string) =>
		call<RepoLanding>("GET", `/repos/${repoPath(repo)}/landing?branch=${encodeURIComponent(branch)}`),
	/** The hive's recent events, newest first. */
	events: (repo: string) => call<{ events: HiveEvent[] }>("GET", `/repos/${repoPath(repo)}/events`),
	/** A person merges a change. It lands as its agent, with the branch's other ready changes, under their name. */
	merge: (repo: string, change: string) =>
		call<{ ok: boolean; commit?: string; reasons?: string[]; conflicts?: string[] }>(
			"POST",
			`/repos/${repoPath(repo)}/changes/${encodeURIComponent(change)}/merge`,
			{},
		),
	/** A person makes a new branch from another, for changes to land on. */
	makeBranch: (repo: string, name: string, from: string) =>
		call<{ name: string; made?: string }>("POST", `/repos/${repoPath(repo)}/branches`, { name, from }),
	/** A repo's files at a branch or commit (its default branch if none). */
	tree: (repo: string, ref?: string) =>
		call<RepoTree>("GET", `/repos/${repoPath(repo)}/tree${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
	/** One file's text at a branch or commit. */
	file: (repo: string, path: string, ref?: string) => {
		const refQuery = ref ? `&ref=${encodeURIComponent(ref)}` : "";
		return call<RepoFile>("GET", `/repos/${repoPath(repo)}/file?path=${encodeURIComponent(path)}${refQuery}`);
	},
	/** A person's vote on a change's current commit. */
	vote: (repo: string, change: string, vote: VoteInput) =>
		call<unknown>("POST", `/repos/${repoPath(repo)}/changes/${encodeURIComponent(change)}/votes`, vote),
	/** One change: its claim or how it ended, its commits and the votes on them. */
	change: (repo: string, change: string) =>
		call<ChangeHistory>("GET", `/repos/${repoPath(repo)}/changes/${encodeURIComponent(change)}`),
	/** What the caller may do in a repo, and whether it's private or public. */
	access: (repo: string) => call<RepoAccess>("GET", `/repos/${repoPath(repo)}/access`),
	/** Opens the standing pull request on GitHub, or finds it; with refresh, rewrites its title and body. */
	githubPull: (repo: string, refresh = false) =>
		call<PullAnswer>("POST", `/repos/${repoPath(repo)}/github/pr`, { refresh }),
	/** A person gives up GitHub's change: its claim released, its paths free, until GitHub's branch moves or asked. */
	giveUpGitHub: (repo: string, change: string) =>
		call<GiveUpAnswer>("POST", `/repos/${repoPath(repo)}/changes/${encodeURIComponent(change)}/give-up`, {}),
	/** GitHive's hosted agents on a repo, if it has had any. */
	hostedAgents: (repo: string) => call<HiveStatus | null>("GET", `/repos/${repoPath(repo)}/hosted-agents`),
	/** People who can write, and whom an admin lists: start `count` hosted agents for `minutes`. */
	startHostedAgents: (repo: string, count: number, minutes: number) =>
		call<HiveStatus>("POST", `/repos/${repoPath(repo)}/hosted-agents`, { count, minutes }),
	/** People who can write: stop the repo's hosted agents; what they started finishes on its own. */
	stopHostedAgents: (repo: string) => call<HiveStatus | null>("DELETE", `/repos/${repoPath(repo)}/hosted-agents`),
	/** Looks at GitHub's branch now and brings its changes back, even a commit given up or sent to a person before. */
	githubAgain: (repo: string) =>
		call<{ fromGitHub?: RepoGitHub["fromGitHub"] }>("POST", `/repos/${repoPath(repo)}/github/again`, {}),
};

/** Repositories, orgs and their people: making, settings, members, teams and collaborators. */
/** A Honeycomb demo run, as GET /demo/runs/:owner/:name answers (see the server's src/demo/run.ts). */
export interface DemoRunStatus {
	id: string;
	/** Its place among all runs. */
	number: number;
	/** The change putting the starting files back, until it lands. */
	reset?: string;
	fullName: string;
	by: string;
	startedAt: number;
	status: "running" | "done" | "stopped" | "failed";
	/** Until its repo is set up for it. */
	settingUp?: boolean;
	/** Why it couldn't start, when it failed. */
	error?: string;
	/** Each agent's own account: its change, the review it's on, and what it has done. */
	agents: HostedAgentAccount[];
	/** How many pieces the backlog has. */
	pieces: number;
	endedAt?: number;
}

/** One of GitHive's hosted agents in a repo's hive: its change, the review it's on, and what it has done. */
export interface HostedAgentAccount {
	name: string;
	change?: string;
	reviewing?: { change: string };
	finished: { piece: string; at: number }[];
	reviewed: number;
	done: boolean;
}

/** A repo's hosted agents, as GET /repos/:owner/:name/hosted-agents answers (null when it never had any). */
export interface HiveStatus {
	names: string[];
	startedAt: number;
	until: number;
	by: string;
	agents: HostedAgentAccount[];
	/** Whether any agent is still taking turns. */
	working: boolean;
}

/** A demo run as the registry lists it. */
export interface DemoRunSlot {
	id: string;
	number: number;
	fullName: string;
	since: number;
}

/** Demo runs: GitHive's hosted agents build Honeycomb again in GitHive's one public demo repo. */
export const demo = {
	start: () => call<{ id: string; repo: string }>("POST", "/demo/runs"),
	/** The run going now, if any, and the latest ones. */
	runs: () =>
		call<{ running: DemoRunSlot | null; recent: DemoRunSlot[]; newest: DemoRunStatus | null }>("GET", "/demo/runs"),
	run: (repo: string) => call<DemoRunStatus>("GET", `/demo/runs/${repoPath(repo)}`),
};

export const manage = {
	/** Every repo the caller can see, by full name. */
	repos: () => call<{ name: string; id: string; visibility: "private" | "public" }[]>("GET", "/repos"),
	createRepo: (input: NewRepoInput) => call<RepoRecord>("POST", "/repos", input),
	setVisibility: (repo: string, visibility: "private" | "public") =>
		call<RepoRecord>("PATCH", `/repos/${repoPath(repo)}`, { visibility }),
	deleteRepo: (repo: string) => call<unknown>("DELETE", `/repos/${repoPath(repo)}`),
	/** Start GitHive on a repo with the default policy (admins only). Saving empty first settings starts it. */
	startRepo: (repo: string) => call<unknown>("POST", `/repos/${repoPath(repo)}/settings`, {}),
	/** Change a started repo's review policy or checks (admins only). Fields left out stay as they are. */
	changeSettings: (repo: string, settings: SettingsInput) =>
		call<SavedMergeSettings>("POST", `/repos/${repoPath(repo)}/settings`, settings),
	collaborators: (repo: string) =>
		call<{ handle: string; permission: Level }[]>("GET", `/repos/${repoPath(repo)}/collaborators`),
	setCollaborator: (repo: string, handle: string, permission: Level) =>
		call<unknown>("PUT", `/repos/${repoPath(repo)}/collaborators/${encodeURIComponent(handle)}`, { permission }),
	removeCollaborator: (repo: string, handle: string) =>
		call<unknown>("DELETE", `/repos/${repoPath(repo)}/collaborators/${encodeURIComponent(handle)}`),
	orgs: () => call<MyOrg[]>("GET", "/orgs"),
	createOrg: (slug: string, name: string) => call<Org>("POST", "/orgs", { slug, name }),
	org: (slug: string) => call<OrgDetail>("GET", `/orgs/${encodeURIComponent(slug)}`),
	updateOrg: (
		slug: string,
		patch: { name?: string | null; default_permission?: Level; members_can_create_repos?: boolean },
	) => call<Org>("PATCH", `/orgs/${encodeURIComponent(slug)}`, patch),
	addMember: (slug: string, email: string, role: OrgRole) =>
		call<AddedMember>("POST", `/orgs/${encodeURIComponent(slug)}/members`, { email, role }),
	setRole: (slug: string, handle: string, role: OrgRole) =>
		call<unknown>("PATCH", `/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(handle)}`, { role }),
	removeMember: (slug: string, handle: string) =>
		call<unknown>("DELETE", `/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(handle)}`),
	cancelInvite: (slug: string, email: string) =>
		call<unknown>("DELETE", `/orgs/${encodeURIComponent(slug)}/invites/${encodeURIComponent(email)}`),
	createTeam: (slug: string, team: string, name: string) =>
		call<{ team: string }>("POST", `/orgs/${encodeURIComponent(slug)}/teams`, { slug: team, name }),
	deleteTeam: (slug: string, team: string) =>
		call<unknown>("DELETE", `/orgs/${encodeURIComponent(slug)}/teams/${encodeURIComponent(team)}`),
	addTeamMember: (slug: string, team: string, handle: string) =>
		call<unknown>(
			"PUT",
			`/orgs/${encodeURIComponent(slug)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(handle)}`,
		),
	removeTeamMember: (slug: string, team: string, handle: string) =>
		call<unknown>(
			"DELETE",
			`/orgs/${encodeURIComponent(slug)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(handle)}`,
		),
};

export type ManageApi = typeof manage;

/** Who is looking, or null when nobody is signed in. A 401 here is the normal signed-out answer. */
export async function fetchMe(): Promise<Me | null> {
	const response = await fetch("/me");
	if (response.status === 401) return null;
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return (await response.json()) as Me;
}

/** Signing in and out, and a signed-in person's agents, tokens and connected apps. */
export const account = {
	/** The sign-in providers set up on this address. */
	/** The sign-in providers set up here, and whether an invite code lets people in. */
	providers: () => call<{ providers: ("github" | "google")[]; inviteCode?: boolean }>("GET", "/auth/providers"),
	signOut: () => call<{ signedOut: boolean }>("POST", "/auth/signout"),
	agents: () => call<MyAgent[]>("GET", "/me/agents"),
	createAgent: (name: string) => call<MyAgent>("POST", "/me/agents", { name }),
	revokeAgent: (id: string) => call<unknown>("DELETE", `/me/agents/${encodeURIComponent(id)}`),
	createToken: (agentId: string, expiresInDays: number | null) =>
		call<IssuedToken>("POST", `/me/agents/${encodeURIComponent(agentId)}/tokens`, { expires_in_days: expiresInDays }),
	revokeToken: (id: string) => call<unknown>("DELETE", `/me/tokens/${encodeURIComponent(id)}`),
	connections: () => call<Connection[]>("GET", "/me/connections"),
	disconnect: (id: string) => call<unknown>("DELETE", `/me/connections/${encodeURIComponent(id)}`),
};

export type AccountApi = typeof account;

/** Adding a member by email adds them, or invites them if they can't sign in yet (pending an admin's approval). */
export interface AddedMember {
	added?: string;
	invited?: string;
	role: OrgRole;
	awaitingApproval?: boolean;
}

/** An email an admin approved to sign in. */
export interface ApprovedEmail {
	email: string;
	invitedBy: string;
	createdAt: string;
}

/** Someone orgs want to add, who can't sign in until an admin approves them. */
export interface InviteRequest {
	email: string;
	orgs: { org: string; role: string; invitedBy: string }[];
	createdAt: string;
	/** Present when they tried to sign in uninvited. */
	signIn?: { provider: string; name: string | null; login: string | null; tries: number; lastAt: string };
}

/** Someone allowed to start GitHive's hosted agents. */
export interface HostedUser {
	handle: string;
	grantedBy: string;
	createdAt: string;
}

/** GitHive's operators, through Cloudflare Access: who may sign in, orgs' requests, and who may use hosted agents. */
export const admin = {
	invites: () => call<ApprovedEmail[]>("GET", "/admin/invites"),
	approve: (email: string) => call<{ invited: string }>("POST", "/admin/invites", { email }),
	removeInvite: (email: string) => call<unknown>("DELETE", `/admin/invites/${encodeURIComponent(email)}`),
	requests: () => call<InviteRequest[]>("GET", "/admin/invite-requests"),
	decline: (email: string) => call<unknown>("DELETE", `/admin/invite-requests/${encodeURIComponent(email)}`),
	hosted: () => call<HostedUser[]>("GET", "/admin/hosted-agents"),
	allowHosted: (handle: string) =>
		call<{ allowed: string }>("PUT", `/admin/hosted-agents/${encodeURIComponent(handle)}`),
	disallowHosted: (handle: string) => call<unknown>("DELETE", `/admin/hosted-agents/${encodeURIComponent(handle)}`),
};

export type AdminApi = typeof admin;

/** Everything the dashboard calls; tests pass stand-ins. */
export type DashboardApi = typeof api;

/** The WebSocket URL of a repo's live feed (GET /repos/:owner/:name/live). Each message means "something changed". */
export function liveFeedUrl(repo: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/repos/${repoPath(repo)}/live`;
}
