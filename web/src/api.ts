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
		/** A question for a person, from an agent or a failed GitHive builder. It stays until a person votes. */
		attention?: { reason: string; agent: string; at: string };
		/** GitHive's hosted agents on the change. */
		hosted?: {
			builder?: { status: string; revisions: number; error?: string };
			reviewers: { role: string; status: string; verdict?: string }[];
		};
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
}

/**
 * What's landing on a branch (GET /repos/:repo/landing): the changes being
 * checked together now, and what changes came to lately. Approved changes
 * land as a set, checked once together, in one push.
 */
export interface RepoLanding {
	branch: string;
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
		| "building";
	/** Who did it. A push names only its change. */
	agent?: string;
	change?: string;
	commit?: string;
	verdict?: "approve" | "reject";
	/** The intent claimed, the role voted as, why a landing failed. */
	detail?: string;
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
};

/** Repositories, orgs and their people: making, settings, members, teams and collaborators. */
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
