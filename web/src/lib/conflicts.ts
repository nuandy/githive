import type { Task } from "../api";
import { changesOf, isActive, timeOf } from "./model";

// Blueprint test-merges every pair of changes in progress (and each change
// with the project's branch) as they push. People don't need the pairwise grid: they need to
// know, on a change, "this conflicts with X in these files".

export interface Conflict {
	/** The other change's id, or the project's branch (`base`). */
	with: string;
	/** It conflicts with the project's branch itself, not another change. */
	base?: boolean;
	withTitle?: string;
	files: string[];
	checkedAt?: string;
}

type Check = NonNullable<Task["checks"]>[number];

/** The newest check for every pair, whichever way round it was recorded. */
export function newestChecks(task: Pick<Task, "checks">): Check[] {
	const newest = new Map<string, Check>();
	for (const check of Array.isArray(task.checks) ? task.checks : []) {
		const pair = check?.pair;
		if (!Array.isArray(pair) || pair.length < 2) continue;
		const key = [...pair].sort().join("\u0000");
		const current = newest.get(key);
		if (!current || (timeOf(check.checkedAt) ?? -Infinity) >= (timeOf(current.checkedAt) ?? -Infinity)) newest.set(key, check);
	}
	return [...newest.values()];
}

/** Conflicts of each change in progress, keyed by change id. Ended changes have none. */
export function conflictsByChange(task: Pick<Task, "checks" | "slices" | "branch">): Map<string, Conflict[]> {
	const active = new Map(changesOf(task).filter(isActive).map((change) => [change.id, change]));
	const result = new Map<string, Conflict[]>();
	for (const check of newestChecks(task)) {
		if (check.status !== "conflict") continue;
		const [a, b] = check.pair;
		for (const [self, other] of [[a, b], [b, a]] as const) {
			if (!active.has(self)) continue;
			if (other !== "base" && !active.has(other)) continue;
			const list = result.get(self) ?? [];
			list.push({
				with: other === "base" ? (task.branch ?? "main") : other,
				...(other === "base" ? { base: true } : {}),
				withTitle: other === "base" ? undefined : active.get(other)?.title,
				files: Array.isArray(check.files) ? check.files : [],
				checkedAt: check.checkedAt,
			});
			result.set(self, list);
		}
	}
	return result;
}

export function conflictsFor(task: Pick<Task, "checks" | "slices" | "branch">, changeId: string): Conflict[] {
	return conflictsByChange(task).get(changeId) ?? [];
}

/** "Conflicts with Fix login (fix-login) in src/a.ts, src/b.ts" */
export function describeConflict(conflict: Conflict): string {
	const who = conflict.base ? conflict.with : conflict.withTitle ? `${conflict.withTitle} (${conflict.with})` : conflict.with;
	return `Conflicts with ${who}${conflict.files.length ? ` in ${conflict.files.join(", ")}` : ""}`;
}
