import { whoWaits } from "./agent";
import { byWaiting } from "./needsYou";
import { counted } from "./plural";
import { type Summaries, waitingIn, type WaitingItem } from "./repos";
import { href, withQuery } from "./routes";
import { timeOf } from "./model";

// The Inbox: everything, across repos, that waits on a person, with why: agents' questions, text Clef flags as
// steering agents, changes waiting on a vote only a person may give, and merges the audit flags. Failed checks aren't
// here: they're the agent's own work. Each repo counts as on the Repositories list and in the Hive (waitingIn,
// needsYou.ts).

export interface InboxItem {
	kind: "question" | "steering" | "vote" | "audit";
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
	/** Who asked, or whose change waits on the vote (newer summaries). */
	agent?: string;
	/** Since when it waits (newer summaries). */
	at?: string;
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
		// Questions, then votes, as the Hive's banner lists them.
		const items = (repo.summary?.waiting ?? []).map((item) => waitingItem(repo.repo, item)).sort(byWaiting);
		if (violations)
			items.push({
				kind: "audit",
				key: "audit",
				title: `${counted(violations, "open audit violation")} to look at`,
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

/**
 * Who waits, as a row's line starts, naming them as the Hive's banner does: "mara/claude asks", "GitHive says", "sam/codex
 * waits on a payments vote", "The audit flags".
 */
export function itemWho(item: InboxItem): string {
	if (item.kind === "audit") return "The audit flags";
	if (item.kind === "steering") return "Clef flags";
	const who = item.agent ? whoWaits(item.agent) : item.kind === "vote" ? "A change" : "An agent";
	if (item.kind === "vote") return `${who} waits on a ${item.role} vote`;
	return `${who} ${who === "GitHive" ? "says" : "asks"}`;
}

/** What the reader does about an item, on its button: answer, vote, look at a flagged change, or read the audit. */
export function itemAction(item: InboxItem): { label: string; href: string } {
	if (item.kind === "audit") return { label: "See the audit", href: item.href };
	if (item.kind === "steering") return { label: "Look", href: item.href };
	// The change's page, opened at its decision.
	const decide = withQuery(item.href, { decide: true });
	return { label: item.kind === "vote" ? `Vote as ${item.role}` : "Answer", href: decide };
}

/**
 * What's in the Inbox now that wasn't when the page last looked (`seen`, the keys it saw). The first look finds
 * nothing new: it's what the page opened on.
 */
export function inboxArrivals(
	seen: ReadonlySet<string> | undefined,
	groups: InboxGroup[],
): { fresh: { repo: string; item: InboxItem }[]; seen: Set<string> } {
	const all = groups.flatMap((group) => group.items.map((item) => ({ repo: group.repo, item })));
	const keyOf = (each: { repo: string; item: InboxItem }) => `${each.repo}\n${each.item.key}`;
	const fresh = seen ? all.filter((each) => !seen.has(keyOf(each))) : [];
	return { fresh, seen: new Set([...(seen ?? []), ...all.map(keyOf)]) };
}

/**
 * A change waiting on a person, as a row: a vote only a person may give, text Clef flags, or (as older summaries are)
 * a question.
 */
function waitingItem(repo: string, item: WaitingItem): InboxItem {
	const shared = {
		key: item.change,
		change: item.change,
		title: item.title || item.change,
		href: href.change(repo, item.change),
		...(item.agent ? { agent: item.agent } : {}),
		...(item.at ? { at: item.at } : {}),
	};
	if (item.kind === "vote" && item.role)
		return { kind: "vote", ...shared, role: item.role, reason: `Only a person can vote as ${item.role}.` };
	if (item.kind === "steering")
		return { kind: "steering", ...shared, reason: `${item.reason} Nothing waits on it: look before it lands.` };
	return {
		kind: "question",
		...shared,
		reason: item.reason,
		...(item.urgency === undefined ? {} : { urgency: item.urgency }),
	};
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
