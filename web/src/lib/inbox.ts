import type { Summaries } from "./repos";
import { href } from "./routes";
import { timeOf } from "./model";

// The Inbox: every change, across repos, that is waiting on a person, with why.

export interface InboxItem {
	change: string;
	title: string;
	reason: string;
	href: string;
	/** How urgent Clef found the agent's question, from 0 (can wait) to 2 (urgent). */
	urgency?: number;
}

/** From here up, a question shows as urgent. */
export const URGENT_FROM = 1.5;

export const isUrgent = (item: InboxItem) => (item.urgency ?? 0) >= URGENT_FROM;

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
		// Someone else's public repo waits on its own people, not the reader.
		if (repo.public) continue;
		const waiting = repo.summary?.waiting ?? [];
		if (!waiting.length) continue;
		groups.push({
			repo: repo.repo,
			repoHref: href.repo(repo.repo),
			lastActivity: repo.summary?.lastActivity,
			items: waiting
				.map((item) => ({
					...item,
					title: item.title || item.change,
					href: href.change(repo.repo, item.change),
				}))
				.sort(byUrgency),
		});
	}
	groups.sort((a, b) => byMostUrgent(a, b) || byLatestActivity(a, b));
	const count = groups.reduce((sum, group) => sum + group.items.length, 0);
	return { groups, count };
}

/** Most urgent first; a question Clef didn't rate stays where it was. */
function byUrgency(a: InboxItem, b: InboxItem): number {
	return (b.urgency ?? 0) - (a.urgency ?? 0);
}

/** A repo with an urgent question first. */
function byMostUrgent(a: InboxGroup, b: InboxGroup): number {
	return Number(b.items.some(isUrgent)) - Number(a.items.some(isUrgent));
}

/** Most recently active first, then by name. */
function byLatestActivity(a: InboxGroup, b: InboxGroup): number {
	const newer = (timeOf(b.lastActivity) ?? 0) - (timeOf(a.lastActivity) ?? 0);
	return newer || a.repo.localeCompare(b.repo);
}
