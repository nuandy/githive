import { fail } from "./errors";
import { unresolvedRequests } from "./lane-requests";
import { isPlainPath } from "./paths";
import type { Slice, Task } from "./types";

// Open mode: agents arrive without a plan. Each opens a change, which is a
// slice created on the fly, and claims the paths it will touch; those paths are
// its lane until the change merges or is abandoned. An open task is one per
// project repo, and its base is the project itself, so changes merge straight
// into the project's main. Everything else (Merge-ahead, Quorum, the gate,
// cross-lane requests, the record in Git) works as for planned tasks.

/** How long a change keeps its claim without activity before it expires. */
export const DEFAULT_LEASE_MINUTES = 30;

/** How long a claim is held while its fork is made; a reservation older than this was lost (the object restarted). */
export const OPENING_LEASE_MS = 5 * 60_000;

/** A change that holds its claim: being opened, or open. */
export const holdsClaim = (slice: Slice) => slice.status === "opening" || slice.status === "building";

/** What the dashboard's repo list shows for an open task, counted from its state. */
export function taskSummary(task: Task, now = new Date().toISOString(), lastActivity = now) {
	const open = task.slices.filter(holdsClaim);
	return {
		open: open.length,
		needsYou: open.filter((s) => s.attention !== undefined && s.attention !== null).length,
		merged: task.slices.filter((s) => s.status === "integrated").length,
		abandoned: task.slices.filter((s) => s.status === "abandoned").length,
		lastActivity,
		countedAt: now,
	};
}

/** The time of the last thing recorded on a task: a change opening or ending, a review, a check run. */
export function lastActivityOf(task: Task) {
	const times = [task.createdAt, ...task.slices.flatMap((s) => [s.openedAt, s.endedAt, s.gate?.at, ...s.reviews.map((r) => r.at)])];
	return times.filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t))).sort().pop() ?? task.createdAt;
}

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
	if (!Array.isArray(paths) || !paths.length) fail(400, "claim at least one path");
	if (paths.length > MAX_CLAIM_PATHS) fail(400, `claim at most ${MAX_CLAIM_PATHS} paths`);
	const out: string[] = [];
	for (const raw of paths) {
		if (typeof raw !== "string") fail(400, "paths must be strings");
		const path = raw.trim().replace(/^\.\//, "");
		// A trailing slash marks a directory; the rest must be a plain path.
		if (!isPlainPath(path.replace(/\/$/, ""))) fail(400, `invalid path: ${raw}`);
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

/** Paths in `owns` that an active (opening or building) change other than `except` holds. */
export function claimConflicts(task: Task, owns: string[], except?: string): ClaimConflict[] {
	const conflicts: ClaimConflict[] = [];
	for (const other of task.slices) {
		if (other.id === except || !holdsClaim(other)) continue;
		for (const path of owns)
			for (const held of other.owns)
				if (entriesOverlap(path, held))
					conflicts.push({ path, holder: other.id, held, title: other.title, intent: other.intent ?? other.instructions });
	}
	return conflicts;
}

/** The refusal an agent sees when its claim collides with another change's (a 409). */
export function conflictMessage(conflicts: ClaimConflict[]) {
	// One entry per holder, with what overlaps under it: a wide claim can overlap dozens of files.
	const holders = new Map<string, ClaimConflict[]>();
	for (const c of conflicts) holders.set(c.holder, [...(holders.get(c.holder) ?? []), c]);
	const SHOWN = 10;
	const lines = [...holders.values()].map((held) => {
		const { holder, title, intent } = held[0];
		const overlaps = held.slice(0, SHOWN).map((c) => (c.path === c.held ? c.path : `${c.path} overlaps ${c.held}`));
		const more = held.length > SHOWN ? `, and ${held.length - SHOWN} more` : "";
		return `- held by change ${holder} ("${title}"): ${intent}\n  ${overlaps.join("; ")}${more}`;
	});
	return `These paths are already claimed:\n${lines.join("\n")}\nNarrow your claim, wait for that change to merge, or open your change on the free paths and ask the holder for what you need with a cross-lane request.`;
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

/**
 * The name an agent gives itself on a change, for people to tell agents apart
 * (who opened it, verified, is `openedBy`). Undefined when none is given;
 * refused unless it's a short name of letters, digits, dots, dashes or underscores.
 */
export function agentName(name: unknown): string | undefined {
	if (name === undefined || name === null || name === "") return undefined;
	if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) fail(400, "agent must be a short name: letters, digits, dots, dashes or underscores, at most 40");
	return name;
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
	return !unresolvedRequests(task, slice.id).length;
}

/** When the next claim could expire, for the Coordinator's alarm. */
export function nextLeaseCheck(task: Task) {
	const times = task.slices.filter((s) => holdsClaim(s) && s.leaseUntil).map((s) => Date.parse(s.leaseUntil!));
	return times.length ? Math.min(...times) : null;
}

/** The claims active changes hold, for agents deciding what to claim. */
export function claimsOf(task: Task) {
	return task.slices
		.filter(holdsClaim)
		.map(({ id, title, intent, instructions, owns, leaseUntil: until, reviewHead }) => ({ change: id, title, intent: intent ?? instructions, owns, leaseUntil: until, inReview: !!reviewHead }));
}
