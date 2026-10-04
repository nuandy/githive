import { fail } from "./errors";
import { DEFAULT_LIMITS, type QueueItem, type Task } from "./types";

// Pure parts of agent scheduling: keys, capacity, and whether queued work is
// still wanted. The Coordinator does the starting.

export type AgentKind = QueueItem["kind"];

/** Builders are keyed by slice; reviewers by slice, role and the commit they review. */
export const itemKey = (item: QueueItem) => (item.kind === "builder" ? item.slice : `${item.slice}:${item.role}:${item.head}`);

export const activeOf = (task: Task, kind: AgentKind) => (kind === "builder" ? task.active.builders : task.active.reviewers);

export const limitOf = (task: Task, kind: AgentKind) => (kind === "builder" ? task.limits.builders : task.limits.reviewers);

export const hasRoom = (task: Task, kind: AgentKind) => activeOf(task, kind).length < limitOf(task, kind);

/** Queued work that no longer makes sense: the slice moved on, or the commit is no longer under review. */
export function stillWanted(task: Task, item: QueueItem) {
	const slice = task.slices.find((s) => s.id === item.slice);
	if (!slice || slice.status !== "building") return false;
	return item.kind === "builder" || slice.reviewHead === item.head;
}

/** Tasks stored before limits existed get the defaults. */
export function withScheduling(task: Task): Task {
	task.limits ??= { ...DEFAULT_LIMITS };
	task.queue ??= [];
	task.active ??= { builders: [], reviewers: [] };
	return task;
}

export function validateLimits(limits: Partial<Task["limits"]> | undefined) {
	const merged = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
	for (const [kind, n] of Object.entries(merged))
		if (!Number.isInteger(n) || n < 1 || n > 50) fail(400, `limits.${kind} must be a whole number from 1 to 50`);
	return merged;
}
