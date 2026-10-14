import type { LandingStretch } from "../api";
import { latest, timeOf } from "./model";
import { justFinished } from "./stretch";

// The Repositories list: the repos agents work on.

export interface RepoRow {
	/** Its full name, <owner>/<name>. */
	name: string;
	/** Claims in force. */
	open: number;
	/** Changes waiting on a person: agents' questions, and votes only people may give. */
	needsYou: number;
	merged: number;
	/** Open audit violations. */
	violations: number;
	lastActivity?: string;
	/** Its last stretch of work, once something has landed. */
	stretch?: LandingStretch;
	/** False until the server has counted the repo's changes (it does so in the background). */
	detailed: boolean;
	/** Someone else's, listed because it's public: shown apart from the reader's own. */
	public?: boolean;
	/** Readable by anyone, signed in or not: the reader's own public repos are marked so. */
	visibility?: "public";
}

/**
 * A change waiting on a person, as the server's summary keeps it: its agent's question (or GitHive's failed builder),
 * or a vote as `role`, which only people may give. Summaries kept before `kind` are questions.
 */
export interface WaitingItem {
	change: string;
	title: string;
	reason: string;
	/** How urgent Clef found an agent's question, from 0 (can wait) to 2 (urgent). */
	urgency?: number;
	kind?: "question" | "vote" | "steering";
	role?: string;
	/** Who asked, or whose change waits on the vote (newer summaries). */
	agent?: string;
	/** Since when: the question's time, or for a vote, when its agent last claimed or extended the change. */
	at?: string;
}

/** What the server keeps per repo for this list (GET /summaries); counts are absent until first taken. */
export interface RepoSummary {
	open?: number;
	/** Changes waiting on a person: agents' questions, and votes only people may give. */
	needsYou?: number;
	merged?: number;
	violations?: number;
	lastActivity?: string;
	lastStretch?: LandingStretch;
	countedAt?: string;
	/** Those changes, with why: the Inbox. */
	waiting?: WaitingItem[];
}

export interface Summaries {
	/** Every repo the reader can see, by full name (<owner>/<name>), with its counts once GitHive has started on it. */
	repos: {
		repo: string;
		id?: string;
		since: string;
		summary: RepoSummary | null;
		public?: boolean;
		visibility?: "public";
	}[];
}

/**
 * What in a repo waits on a person, from its summary: its changes (agents' questions and votes only people may give,
 * as the Hive's needsYou.ts finds them) and the audit's open violations. The Inbox and this list count the same.
 */
export function waitingIn(summary: RepoSummary | null | undefined): { changes: number; violations: number } {
	return {
		changes: Math.max(summary?.needsYou ?? 0, summary?.waiting?.length ?? 0),
		violations: summary?.violations ?? 0,
	};
}

function summaryRow(listed: Summaries["repos"][number]): RepoRow {
	const { repo: name, since, summary } = listed;
	const waiting = waitingIn(summary);
	return {
		...(listed.public ? { public: true } : {}),
		...(listed.visibility === "public" ? { visibility: "public" as const } : {}),
		name,
		open: summary?.open ?? 0,
		needsYou: waiting.changes,
		merged: summary?.merged ?? 0,
		violations: waiting.violations,
		lastActivity: latest(since, summary?.lastActivity),
		...(summary?.lastStretch ? { stretch: summary.lastStretch } : {}),
		detailed: summary?.open !== undefined,
	};
}

/** Every repo, most recently active first. */
export function buildRepoRows(summaries: Summaries): RepoRow[] {
	return (summaries.repos ?? []).map(summaryRow).sort(byLatestActivity);
}

function byLatestActivity(a: RepoRow, b: RepoRow): number {
	const newer = (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0);
	return newer || a.name.localeCompare(b.name);
}

export function filterRepos(rows: RepoRow[], query: string): RepoRow[] {
	const needle = query.trim().toLowerCase();
	return needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;
}

/** Its open changes and audit violations, in words: "3 open, 1 audit violation". */
export function repoCounts(row: RepoRow): string {
	const parts = [`${row.open} open`];
	if (row.violations) {
		const noun = row.violations === 1 ? "violation" : "violations";
		parts.push(`${row.violations} audit ${noun}`);
	}
	return parts.join(", ");
}

/**
 * What a repo needs, as its lamp: a person (a question or an audit finding), work under way, nothing now but a
 * stretch of work that just landed, or nothing.
 */
export type RepoState = "needs-you" | "at-work" | "done" | "quiet";

export function repoState(row: RepoRow, now = Date.now()): RepoState {
	if (row.needsYou || row.violations) return "needs-you";
	if (row.open) return "at-work";
	return justFinished(row.stretch, now) ? "done" : "quiet";
}

/** The groups the Repositories page shows, in order, each with the repos in it (empty groups left out). */
export const REPO_GROUPS: { state: RepoState; title: string }[] = [
	{ state: "needs-you", title: "Needs you" },
	{ state: "at-work", title: "At work" },
	{ state: "done", title: "Just finished" },
	{ state: "quiet", title: "Quiet" },
];

export function groupRepos(rows: RepoRow[], now = Date.now()): { state: RepoState; title: string; rows: RepoRow[] }[] {
	const groups = REPO_GROUPS.map((group) => ({
		...group,
		rows: rows.filter((row) => repoState(row, now) === group.state),
	}));
	return groups.filter((group) => group.rows.length);
}
