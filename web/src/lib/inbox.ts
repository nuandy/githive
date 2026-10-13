import { counted } from "./plural";
import { type Summaries, waitingIn, type WaitingItem } from "./repos";
import { href } from "./routes";
import { timeOf } from "./model";

// The Inbox: everything, across repos, that waits on a person, with why: agents' questions, changes waiting on a vote
// only a person may give, and merges the audit flags. Failed checks aren't here: they're the agent's own work. Each
// repo counts as on the Repositories list and in the Hive (waitingIn, needsYou.ts).

export interface InboxItem {
	kind: "question" | "vote" | "audit";
	/** Unique in its repo: the change, or "audit". */
	key: string;
	/** The change a question or a vote is about. */
	change?: string;
	title: string;
	reason: string;
	href: string;
	/** How urgent Clef found the agent's question, from 0 (can wait) to 2 (urgent). */
	urgency?: number;
	/** The role a vote is for. */
	role?: string;
}

/** From here up, a question shows as urgent. */
export const URGENT_FROM = 1.5;

export const isUrgent = (item: InboxItem) => (item.urgency ?? 0) >= URGENT_FROM;

export interface InboxGroup {
	repo: string;
	repoHref: string;
	lastActivity?: string;
	items: InboxItem[];
	/** What waits on a person here: each change, and each of the audit's open violations. */
	count: number;
}

export function buildInbox(summaries: Summaries | undefined): { groups: InboxGroup[]; count: number } {
	if (!summaries) return { groups: [], count: 0 };
	const groups: InboxGroup[] = [];
	for (const repo of summaries.repos ?? []) {
		// Someone else's public repo waits on its own people, not the reader.
		if (repo.public) continue;
		const { changes, violations } = waitingIn(repo.summary);
		if (!changes && !violations) continue;
		const items = (repo.summary?.waiting ?? []).map((item) => waitingItem(repo.repo, item)).sort(byUrgency);
		if (violations)
			items.push({
				kind: "audit",
				key: "audit",
				title: `${counted(violations, "merge")} for the audit to look at`,
				reason: "They broke the repo's rules; the Audit tab says how.",
				href: href.repo(repo.repo, "audit"),
			});
		groups.push({
			repo: repo.repo,
			repoHref: href.repo(repo.repo),
			lastActivity: repo.summary?.lastActivity,
			items,
			count: changes + violations,
		});
	}
	groups.sort((a, b) => byMostUrgent(a, b) || byLatestActivity(a, b));
	const count = groups.reduce((sum, group) => sum + group.count, 0);
	return { groups, count };
}

/** A change waiting on a person, as a row: a vote only a person may give, or (as older summaries are) a question. */
function waitingItem(repo: string, item: WaitingItem): InboxItem {
	const shared = {
		key: item.change,
		change: item.change,
		title: item.title || item.change,
		href: href.change(repo, item.change),
	};
	if (item.kind === "vote" && item.role)
		return { kind: "vote", ...shared, role: item.role, reason: `Only a person can vote as ${item.role}.` };
	return {
		kind: "question",
		...shared,
		reason: item.reason,
		...(item.urgency === undefined ? {} : { urgency: item.urgency }),
	};
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
