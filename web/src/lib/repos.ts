import { latest, timeOf } from "./model";

// The Repositories list: open-mode repos (one task each, run by an elected
// coordinator) and coordinator-free repos, side by side.

export type RepoMode = "elected" | "coordinator-free";

/**
 * The id of a repo's open task, as the server names it (src/open-mode.ts): the
 * first four bytes of SHA-256("open:<repo>"), in hex. A repo page finds its task
 * by this at once, rather than waiting for the list of every task.
 */
export async function openTaskId(repo: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`open:${repo}`)));
	return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RepoRow {
	name: string;
	mode: RepoMode;
	taskId?: string;
	/** Changes in progress (open mode) or claims in force (coordinator-free). */
	open: number;
	/** Changes waiting on a person. */
	needsYou: number;
	merged: number;
	/** Open audit violations (coordinator-free). */
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
	abandoned?: number;
	violations?: number;
	lastActivity?: string;
	countedAt?: string;
	/** Changes waiting on a person, with why: the Inbox. */
	waiting?: { change: string; title: string; reason: string }[];
}

export interface Summaries {
	tasks: { id: string; repo: string; createdAt: string; elected?: boolean; summary: RepoSummary | null }[];
	free: { repo: string; since: string; summary: RepoSummary | null }[];
}

function summaryRow(name: string, mode: RepoMode, since: string, summary: RepoSummary | null, taskId?: string): RepoRow {
	return {
		name,
		mode,
		...(taskId ? { taskId } : {}),
		open: summary?.open ?? 0,
		needsYou: summary?.needsYou ?? 0,
		merged: summary?.merged ?? 0,
		violations: summary?.violations ?? 0,
		lastActivity: latest(since, summary?.lastActivity),
		detailed: summary?.open !== undefined,
	};
}

/** One task per repo: the one it is open as (elected first, then the newest). */
export function newestTaskPerRepo(tasks: Summaries["tasks"]): Summaries["tasks"] {
	const byRepo = new Map<string, Summaries["tasks"][number]>();
	for (const task of tasks) {
		const current = byRepo.get(task.repo);
		const rank = (t: Summaries["tasks"][number]) => [t.elected ? 1 : 0, timeOf(t.createdAt) ?? 0] as const;
		if (!current || rank(task)[0] > rank(current)[0] || (rank(task)[0] === rank(current)[0] && rank(task)[1] > rank(current)[1])) byRepo.set(task.repo, task);
	}
	return [...byRepo.values()];
}

/** Every repo, most recently active first: one row per repo, its open-mode task (the newest, if the repo has several). */
export function buildRepoRows(summaries: Summaries): RepoRow[] {
	const rows = newestTaskPerRepo(summaries.tasks).map((task) => summaryRow(task.repo, "elected", task.createdAt, task.summary, task.id));
	for (const repo of summaries.free) rows.push(summaryRow(repo.repo, "coordinator-free", repo.since, repo.summary));
	return rows.sort((a, b) => (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0) || a.name.localeCompare(b.name));
}

export function filterRepos(rows: RepoRow[], query: string): RepoRow[] {
	const q = query.trim().toLowerCase();
	return q ? rows.filter((row) => row.name.toLowerCase().includes(q) || row.mode.includes(q)) : rows;
}

/** One line under a repo's name: "3 open · 1 violation". (What needs you has its own badge.) */
export function repoCounts(row: RepoRow): string {
	const parts = [`${row.open} open`];
	if (row.violations) parts.push(`${row.violations} ${row.violations === 1 ? "violation" : "violations"}`);
	return parts.join(" · ");
}
