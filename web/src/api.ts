import type { Summaries } from "./lib/repos";

// The dashboard's calls to the Worker.

/** A repo, as the dashboard shows it (GET /repos/:repo). */
export interface RepoSnapshot {
	repo: string;
	/** `grants`: who may vote as each role that can block a merge (newer servers; unlisted: people and GitHive's reviewers). */
	policy: { required: number; vetoes: string[]; escalate?: { paths: string[]; required?: number; vetoes?: string[] }[]; grants?: Record<string, string[]> };
	verify: string[];
	/** The project's branch changes merge into (older servers: absent, main). */
	branch?: string;
	/** Whether records and merges are stamped with verified identity. */
	verified: boolean;
	/** How claims are kept (newer servers): in one record until the load calls for shards ("on demand"), always ("never"), or sharded since `since`. */
	sharding?: "on demand" | "never" | { since?: string; because?: string };
	/** How many path segments deep claims are sharded, once they are. */
	shardDepth?: number;
	/** How votes are kept (newer servers): in one record until the load calls for buckets ("on demand"), always ("never"), or in buckets since `since`. */
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
		approval: { approved: boolean; approvals: number; required: number; vetoedBy: string[]; /** Veto roles that haven't approved yet (newer servers); a change merges only once each has. */ awaiting?: string[] };
		/** A question for a person about the change (an agent asked, or GitHive's builder failed), until a person votes. */
		attention?: { reason: string; agent: string; at: string };
		/** GitHive's hosted agents on the change. */
		hosted?: { builder?: { status: string; revisions: number; error?: string }; reviewers: { role: string; status: string; verdict?: string }[] };
	}[];
	votes: { commit: string; reviewer: string; role: string; verdict: "approve" | "reject"; evidence: string; at: string; by?: string }[];
	/** Loaded apart (GET /repos/:repo/audit): it replays every record, so it comes slower and less often. */
	audit?: RepoAudit;
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

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Not JSON: an older server without this route answers with the dashboard page.
		throw new Error(res.ok ? `Unexpected response from ${path}` : `${res.status} ${res.statusText}`);
	}
	if (!res.ok) {
		const detail = asRecord(data)?.error;
		throw new Error(res.status === 401 ? "Unauthorized: sign in through Cloudflare Access." : typeof detail === "string" ? detail : `${res.status} ${res.statusText}`);
	}
	return data as T;
}

export const api = {
	/** Every repo with its counts, for the Repositories list and the Inbox (one read, kept by the server). */
	summaries: () => call<Summaries>("GET", "/summaries"),
	snapshot: (repo: string) => call<RepoSnapshot>("GET", `/repos/${encodeURIComponent(repo)}`),
	audit: (repo: string) => call<RepoAudit>("GET", `/repos/${encodeURIComponent(repo)}/audit`),
	/** A repo's files at a branch or commit (its default branch if none). */
	tree: (repo: string, ref?: string) => call<RepoTree>("GET", `/repos/${encodeURIComponent(repo)}/tree${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
	/** One file's text at a branch or commit. */
	file: (repo: string, path: string, ref?: string) =>
		call<RepoFile>("GET", `/repos/${encodeURIComponent(repo)}/file?path=${encodeURIComponent(path)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
	/** A person's vote on a change's current commit. */
	vote: (repo: string, change: string, vote: VoteInput) => call<unknown>("POST", `/repos/${encodeURIComponent(repo)}/changes/${encodeURIComponent(change)}/votes`, vote),
	/** One change: its claim or how it ended, its commits and the votes on them. */
	change: (repo: string, change: string) => call<ChangeHistory>("GET", `/repos/${encodeURIComponent(repo)}/changes/${encodeURIComponent(change)}`),
};

/** Everything the dashboard calls; tests pass stand-ins. */
export type DashboardApi = typeof api;

/** The WebSocket URL of a repo's live feed ("repo:<repo>"). Each message means "something changed". */
export function liveFeedUrl(key: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live/${key}`;
}
