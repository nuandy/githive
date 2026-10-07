import type { FreeSnapshot } from "../api";
import { identityName } from "./agent";
import { latest } from "./model";

// The Agents tab: who works on a repo and who reviews it. Coordinator-free
// repos keep no list of agents: they come from the claims in force and the votes.

export interface AuthorStats {
	name: string;
	opened: number;
	open: number;
	merged: number;
	abandoned: number;
	lastActive?: string;
}

export interface ReviewerStats {
	name: string;
	/** The roles reviewed for. */
	roles: string[];
	approvals: number;
	rejections: number;
	/** Blueprint's own reviewer, not an outside agent or a person. */
	hosted: boolean;
	lastActive?: string;
}

const byActivity = <T extends { opened?: number; approvals?: number; rejections?: number; name: string }>(a: T, b: T) => {
	const weight = (x: T) => (x.opened ?? 0) + (x.approvals ?? 0) + (x.rejections ?? 0);
	return weight(b) - weight(a) || a.name.localeCompare(b.name);
};

/** Coordinator-free repos keep no change records: agents come from the claims in force and the votes. */
export function freeAuthorStats(snapshot: Pick<FreeSnapshot, "claims">): AuthorStats[] {
	const authors = new Map<string, AuthorStats>();
	for (const claim of snapshot.claims) {
		const name = claim.agent || identityName(claim.by) || "agent";
		const stats = authors.get(name) ?? { name, opened: 0, open: 0, merged: 0, abandoned: 0 };
		stats.opened++;
		stats.open++;
		stats.lastActive = latest(stats.lastActive, claim.active, claim.since);
		authors.set(name, stats);
	}
	return [...authors.values()].sort(byActivity);
}

export function freeReviewerStats(snapshot: Pick<FreeSnapshot, "votes">): ReviewerStats[] {
	const reviewers = new Map<string, ReviewerStats>();
	for (const vote of snapshot.votes) {
		const name = vote.reviewer || identityName(vote.by) || "reviewer";
		const stats = reviewers.get(name) ?? { name, roles: [], approvals: 0, rejections: 0, hosted: false };
		if (vote.role && !stats.roles.includes(vote.role)) stats.roles.push(vote.role);
		if (vote.verdict === "approve") stats.approvals++;
		else stats.rejections++;
		stats.lastActive = latest(stats.lastActive, vote.at);
		reviewers.set(name, stats);
	}
	return [...reviewers.values()].sort(byActivity);
}
