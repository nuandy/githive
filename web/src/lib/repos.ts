import { latest, timeOf } from "./model";

// The Repositories list: the coordinator-free repos agents work on.

export interface RepoRow {
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
	free: { repo: string; since: string; summary: RepoSummary | null }[];
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
	return (summaries.free ?? [])
		.map((repo) => summaryRow(repo.repo, repo.since, repo.summary))
		.sort((a, b) => (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0) || a.name.localeCompare(b.name));
}

export function filterRepos(rows: RepoRow[], query: string): RepoRow[] {
	const q = query.trim().toLowerCase();
	return q ? rows.filter((row) => row.name.toLowerCase().includes(q)) : rows;
}

/** One line under a repo's name: "3 open · 1 violation". (What needs you has its own badge.) */
export function repoCounts(row: RepoRow): string {
	const parts = [`${row.open} open`];
	if (row.violations) parts.push(`${row.violations} ${row.violations === 1 ? "violation" : "violations"}`);
	return parts.join(" · ");
}
