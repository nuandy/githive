import type { Slice, Task } from "./types";

// Open mode: agents arrive without a plan. Each opens a change, which is a
// slice created on the fly, and claims the paths it will touch; those paths are
// its lane until the change merges or is abandoned. An open task is one per
// project repo, and its base is the project itself, so changes merge straight
// into the project's main. Everything else (Merge-ahead, Quorum, the gate,
// cross-lane requests, the record in Git) works as for planned tasks.

/** How long a change keeps its claim without activity before it expires. */
export const DEFAULT_LEASE_MINUTES = 30;

/** Longest a claim may list, so one change can't take a whole repo by accident. */
export const MAX_CLAIM_PATHS = 50;

/**
 * Whether `path` is inside a lane entry, matching whole path segments: the lane
 * `src/stats` holds `src/stats` and `src/stats/a.ts`, but not `src/stats-extra.ts`.
 * A trailing slash marks a directory, as in `src/stats/`.
 */
export function inLaneEntry(path: string, entry: string) {
	if (entry.endsWith("/")) return path.startsWith(entry);
	return path === entry || path.startsWith(`${entry}/`);
}

export const inLane = (path: string, owns: string[]) => owns.some((entry) => inLaneEntry(path, entry));

/** Whether two lane entries can hold a common path. */
export function entriesOverlap(a: string, b: string) {
	const dirA = a.endsWith("/") ? a : `${a}/`;
	const dirB = b.endsWith("/") ? b : `${b}/`;
	return a === b || dirA === dirB || inLaneEntry(b, a) || inLaneEntry(a, b) || dirA.startsWith(dirB) || dirB.startsWith(dirA);
}

/** Normalize and validate claimed paths: relative, no `..`, no empty segments. Throws `[400]` with the reason. */
export function normalizeClaim(paths: unknown): string[] {
	if (!Array.isArray(paths) || !paths.length) throw new Error("[400] claim at least one path");
	if (paths.length > MAX_CLAIM_PATHS) throw new Error(`[400] claim at most ${MAX_CLAIM_PATHS} paths`);
	const out: string[] = [];
	for (const raw of paths) {
		if (typeof raw !== "string") throw new Error("[400] paths must be strings");
		const path = raw.trim().replace(/^\.\//, "");
		const segments = path.replace(/\/$/, "").split("/");
		if (!path || path === "/" || path.startsWith("/") || segments.some((s) => !s || s === "." || s === ".."))
			throw new Error(`[400] invalid path: ${raw}`);
		if (!out.includes(path)) out.push(path);
	}
	return out;
}

/** A claimed path that an active change already holds. */
export interface ClaimConflict {
	path: string;
	holder: string;
	held: string;
	title: string;
	intent: string;
}

/** Paths in `owns` that an active (building) change other than `except` holds. */
export function claimConflicts(task: Task, owns: string[], except?: string): ClaimConflict[] {
	const conflicts: ClaimConflict[] = [];
	for (const other of task.slices) {
		if (other.id === except || other.status !== "building") continue;
		for (const path of owns)
			for (const held of other.owns)
				if (entriesOverlap(path, held))
					conflicts.push({ path, holder: other.id, held, title: other.title, intent: other.intent ?? other.instructions });
	}
	return conflicts;
}

/** The refusal an agent sees when its claim collides with another change's. */
export function conflictMessage(conflicts: ClaimConflict[]) {
	const lines = conflicts.map((c) => `- ${c.path} overlaps ${c.held}, held by change ${c.holder} ("${c.title}"): ${c.intent}`);
	return `[409] These paths are already claimed:\n${lines.join("\n")}\nNarrow your claim, wait for that change to merge, or open your change on the free paths and ask the holder for what you need with a cross-lane request.`;
}

/** A slug id for a new change: words from its title plus 4 random hex characters. */
export function changeId(title: string) {
	const words = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24)
		.replace(/-+$/, "");
	const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
	return `${words || "change"}-${suffix}`;
}

/** The open task's id for a repo: stable, so every agent finds the same one. 8 hex characters, like any task id. */
export async function openTaskId(repo: string) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`open:${repo}`)));
	return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const leaseUntil = (task: Task, now = Date.now()) => new Date(now + (task.leaseMinutes ?? DEFAULT_LEASE_MINUTES) * 60_000).toISOString();

/**
 * Whether a change's claim has expired. A change that is waiting on the
 * platform rather than its agent (in review or at the gate) or on another
 * change (an unresolved cross-lane request) never expires.
 */
export function leaseExpired(task: Task, slice: Slice, now = Date.now()) {
	if (slice.status !== "building" || !slice.leaseUntil) return false;
	if (Date.parse(slice.leaseUntil) > now) return false;
	if (slice.reviewHead && slice.reviewHead !== slice.sentBackFor) return false;
	if (slice.gate && ["queued", "running", "waiting"].includes(slice.gate.status)) return false;
	const waiting = (task.laneChangeRequests ?? []).some((r) => r.requester === slice.id && (r.status === "pending" || r.status === "answered"));
	return !waiting;
}

/** When the next claim could expire, for the Coordinator's alarm. */
export function nextLeaseCheck(task: Task) {
	const times = task.slices.filter((s) => s.status === "building" && s.leaseUntil).map((s) => Date.parse(s.leaseUntil!));
	return times.length ? Math.min(...times) : null;
}
