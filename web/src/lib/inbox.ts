import type { Summaries } from "./repos";
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
	repoHref: string;
	lastActivity?: string;
	items: InboxItem[];
}

export function buildInbox(summaries: Summaries | undefined): { groups: InboxGroup[]; count: number } {
	if (!summaries) return { groups: [], count: 0 };
	const groups: InboxGroup[] = [];
	for (const repo of summaries.repos ?? []) {
		const waiting = repo.summary?.waiting ?? [];
		if (!waiting.length) continue;
		groups.push({
			repo: repo.repo,
			repoHref: href.repo(repo.repo),
			lastActivity: repo.summary?.lastActivity,
			items: waiting.map((item) => ({
				...item,
				title: item.title || item.change,
				href: href.change(repo.repo, item.change),
			})),
		});
	}
	groups.sort(byLatestActivity);
	const count = groups.reduce((sum, group) => sum + group.items.length, 0);
	return { groups, count };
}

/** Most recently active first, then by name. */
function byLatestActivity(a: InboxGroup, b: InboxGroup): number {
	const newer = (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0);
	return newer || a.repo.localeCompare(b.repo);
}
