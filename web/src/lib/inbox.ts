import { newestTaskPerRepo, type RepoMode, type Summaries } from "./repos";
import { href } from "./routes";
import { timeOf } from "./model";

// The Inbox: every change, across repos, that is waiting on a person, with why.

export interface InboxItem {
	change: string;
	title: string;
	reason: string;
	href: string;
}

export interface InboxGroup {
	repo: string;
	mode: RepoMode;
	repoHref: string;
	lastActivity?: string;
	items: InboxItem[];
}

export function buildInbox(summaries: Summaries | undefined): { groups: InboxGroup[]; count: number } {
	if (!summaries) return { groups: [], count: 0 };
	const groups: InboxGroup[] = [];
	for (const task of newestTaskPerRepo(summaries.tasks)) {
		const waiting = task.summary?.waiting ?? [];
		if (!waiting.length) continue;
		groups.push({
			repo: task.repo,
			mode: "elected",
			repoHref: href.repo(task.repo),
			lastActivity: task.summary?.lastActivity,
			items: waiting.map((item) => ({ ...item, title: item.title || item.change, href: href.change(task.repo, item.change) })),
		});
	}
	for (const repo of summaries.free) {
		const waiting = repo.summary?.waiting ?? [];
		if (!waiting.length) continue;
		groups.push({
			repo: repo.repo,
			mode: "coordinator-free",
			repoHref: href.repo(repo.repo, "changes", "free"),
			lastActivity: repo.summary?.lastActivity,
			items: waiting.map((item) => ({ ...item, title: item.title || item.change, href: href.change(repo.repo, item.change, "conversation", "free") })),
		});
	}
	groups.sort((a, b) => (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0) || a.repo.localeCompare(b.repo));
	return { groups, count: groups.reduce((sum, group) => sum + group.items.length, 0) };
}
