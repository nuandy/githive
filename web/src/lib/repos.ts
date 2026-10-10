import { latest, timeOf } from "./model";

// The Repositories list: the repos agents work on.

export interface RepoRow {
	/** Its full name, <owner>/<name>. */
	name: string;
	/** Claims in force. */
	open: number;
	/** Changes waiting on a person. */
	needsYou: number;
	merged: number;
	/** Open audit violations. */
	violations: number;
	lastActivity?: string;
	/** False until the server has counted the repo's changes (it does so in the background). */
	detailed: boolean;
}

/** What the server keeps per repo for this list (GET /summaries); counts are absent until first taken. */
export interface RepoSummary {
	open?: number;
	needsYou?: number;
	merged?: number;
	violations?: number;
	lastActivity?: string;
	countedAt?: string;
	/** Changes waiting on a person, with why: the Inbox. */
	waiting?: { change: string; title: string; reason: string }[];
}

export interface Summaries {
	/** Every repo the reader can see, by full name (<owner>/<name>), with its counts once GitHive has started on it. */
	repos: { repo: string; id?: string; since: string; summary: RepoSummary | null }[];
}

function summaryRow(name: string, since: string, summary: RepoSummary | null): RepoRow {
	return {
		name,
		open: summary?.open ?? 0,
		needsYou: summary?.needsYou ?? 0,
		merged: summary?.merged ?? 0,
		violations: summary?.violations ?? 0,
		lastActivity: latest(since, summary?.lastActivity),
		detailed: summary?.open !== undefined,
	};
}

/** Every repo, most recently active first. */
export function buildRepoRows(summaries: Summaries): RepoRow[] {
	return (summaries.repos ?? []).map((repo) => summaryRow(repo.repo, repo.since, repo.summary)).sort(byLatestActivity);
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

/** What a repo needs, as its lamp: a person (a question or an audit finding), work under way, or nothing. */
export type RepoState = "needs-you" | "at-work" | "quiet";

export function repoState(row: RepoRow): RepoState {
	if (row.needsYou || row.violations) return "needs-you";
	return row.open ? "at-work" : "quiet";
}

/** The groups the Repositories page shows, in order, each with the repos in it (empty groups left out). */
export const REPO_GROUPS: { state: RepoState; title: string }[] = [
	{ state: "needs-you", title: "Needs you" },
	{ state: "at-work", title: "At work" },
	{ state: "quiet", title: "Quiet" },
];

export function groupRepos(rows: RepoRow[]): { state: RepoState; title: string; rows: RepoRow[] }[] {
	const groups = REPO_GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => repoState(row) === group.state) }));
	return groups.filter((group) => group.rows.length);
}
