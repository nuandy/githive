import type { FreeSnapshot, Task } from "../api";
import { changeLastActivity, changesOf, isActive, latest, timeOf } from "./model";

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
	/** False until the repo's details have loaded (coordinator-free snapshots load separately). */
	detailed: boolean;
}

/** The task each repo is open as: the newest one, preferring open mode. */
export function tasksByRepo(tasks: Task[]): Map<string, Task> {
	const byRepo = new Map<string, Task>();
	for (const task of tasks) {
		if (!task || typeof task.repo !== "string") continue;
		const current = byRepo.get(task.repo);
		if (!current) {
			byRepo.set(task.repo, task);
			continue;
		}
		const rank = (t: Task) => [t.mode === "open" ? 1 : 0, timeOf(t.createdAt) ?? 0] as const;
		const [aOpen, aTime] = rank(task);
		const [bOpen, bTime] = rank(current);
		if (aOpen > bOpen || (aOpen === bOpen && aTime > bTime)) byRepo.set(task.repo, task);
	}
	return byRepo;
}

export function taskRow(task: Task): RepoRow {
	const changes = changesOf(task);
	const active = changes.filter(isActive);
	return {
		name: task.repo,
		mode: "elected",
		taskId: task.id,
		open: active.length,
		needsYou: active.filter((change) => change.attention !== undefined && change.attention !== null).length,
		merged: changes.filter((change) => change.status === "integrated").length,
		violations: 0,
		lastActivity: latest(task.createdAt, ...changes.map(changeLastActivity)),
		detailed: true,
	};
}

export function freeRow(repo: { repo: string; since: string }, snapshot?: FreeSnapshot): RepoRow {
	const claims = snapshot?.claims ?? [];
	return {
		name: repo.repo,
		mode: "coordinator-free",
		open: claims.length,
		needsYou: claims.filter((claim) => claim.hosted?.builder?.status === "failed").length,
		merged: snapshot?.audit?.merges ?? 0,
		violations: snapshot?.audit?.open ?? 0,
		lastActivity: latest(repo.since, ...claims.map((claim) => claim.active), ...(snapshot?.votes ?? []).map((vote) => vote.at)),
		detailed: !!snapshot,
	};
}

/** Every repo, most recently active first. */
export function buildRepoRows(tasks: Task[], freeRepos: { repo: string; since: string }[], snapshots: Record<string, FreeSnapshot | undefined> = {}): RepoRow[] {
	const rows = [...tasksByRepo(tasks).values()].map(taskRow);
	for (const repo of freeRepos) rows.push(freeRow(repo, snapshots[repo.repo]));
	return rows.sort((a, b) => (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0) || a.name.localeCompare(b.name));
}

export function filterRepos(rows: RepoRow[], query: string): RepoRow[] {
	const q = query.trim().toLowerCase();
	return q ? rows.filter((row) => row.name.toLowerCase().includes(q) || row.mode.includes(q)) : rows;
}

/** One line under a repo's name: "3 open · 1 needs you". */
export function repoCounts(row: RepoRow): string {
	const parts = [`${row.open} open`];
	if (row.needsYou) parts.push(`${row.needsYou} needs you`);
	if (row.violations) parts.push(`${row.violations} ${row.violations === 1 ? "violation" : "violations"}`);
	return parts.join(" · ");
}
