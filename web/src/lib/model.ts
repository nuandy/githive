import type { Slice, Task } from "../api";

/**
 * A change as the dashboard sees it. On the server a change is stored as a
 * "slice"; people only ever see "change". `openedAt`, `openedBy` and
 * `endedAt` are recent additions, so older records may not carry them.
 */
export type Change = Slice & { openedAt?: string; openedBy?: string; endedAt?: string };

export type Review = Change["reviews"][number];
export type ReviewPolicy = Task["review"];

/** Which filter a change belongs to on a repo's Changes tab. */
export type ChangeState = "open" | "merged" | "abandoned";

export function changeState(change: Pick<Change, "status">): ChangeState {
	if (change.status === "integrated") return "merged";
	if (change.status === "abandoned") return "abandoned";
	return "open";
}

export const isActive = (change: Pick<Change, "status">) => changeState(change) === "open";

export function changesOf(task: Pick<Task, "slices"> | null | undefined): Change[] {
	return Array.isArray(task?.slices) ? (task.slices as Change[]) : [];
}

/** Milliseconds since epoch, or undefined for a missing/invalid timestamp. */
export function timeOf(iso: string | undefined | null): number | undefined {
	if (!iso) return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

/** The latest of several timestamps, as given (ISO), or undefined if none is valid. */
export function latest(...times: (string | undefined | null)[]): string | undefined {
	let best: string | undefined;
	let bestMs = -Infinity;
	for (const time of times) {
		const ms = timeOf(time);
		if (ms !== undefined && ms > bestMs) {
			best = time!;
			bestMs = ms;
		}
	}
	return best;
}

export const shortSha = (commit: string | undefined | null) => (commit ? commit.slice(0, 7) : "");

/** When anything last happened on a change, as far as its record shows. */
export function changeLastActivity(change: Change): string | undefined {
	return latest(
		change.openedAt,
		change.endedAt,
		change.gate?.at,
		...(change.reviews ?? []).map((review) => review?.at),
		...(change.waivers ?? []).map((waiver) => waiver?.at),
		...(change.inbox ?? []).map((message) => message?.at),
	);
}
