import type { Leader, Task } from "../api";
import { changesOf, isActive, type Change, type ReviewPolicy } from "./model";
import { changePolicy, reviewSummary } from "./changeStatus";

// Who coordinates an elected repo, and whether a person can review a change.

/** The change whose agent leads: the leader is named "<taskId>--<changeId>". */
export function leaderChangeId(leader: Leader | undefined, taskId: string): string | null {
	const name = leader?.leader;
	if (!name) return null;
	const prefix = `${taskId}--`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function leaderChange(leader: Leader | undefined, task: Pick<Task, "id" | "slices">): { id: string; change?: Change } | null {
	const id = leaderChangeId(leader, task.id);
	if (!id) return null;
	return { id, change: changesOf(task).find((c) => c.id === id) };
}

/** A change a person can review now: its commit is in review and hasn't been sent back. */
export function canReview(change: Change, policy?: ReviewPolicy): boolean {
	if (!(isActive(change) && change.status === "building" && !!change.reviewHead && change.sentBackFor !== change.reviewHead)) return false;
	// Once approved (or waived), another vote changes nothing: the checks decide now.
	const review = policy ? reviewSummary(change, policy).state : undefined;
	return review !== "approved" && review !== "waived";
}

/** The roles of the change's policy, and the first that hasn't voted on the commit under review. */
export function reviewRoles(change: Change, task: Pick<Task, "review">): { roles: string[]; suggested: string | undefined } {
	const policy = changePolicy(change, task);
	const roles = [...new Set(policy.reviewers ?? [])];
	const voted = new Set((change.reviews ?? []).filter((r) => r?.head === change.reviewHead).map((r) => r.reviewer));
	return { roles, suggested: roles.find((role) => !voted.has(role)) ?? roles[0] };
}

/** Pushes, newest first. */
export function pushesNewestFirst(change: Change): NonNullable<Change["pushes"]> {
	return [...(change.pushes ?? [])].reverse();
}
