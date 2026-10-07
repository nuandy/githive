import { fail } from "./errors";
import { isPlainPath } from "./paths";

// Claimed paths: what a claim covers, and when two claims overlap. A path with
// a trailing slash is a directory and covers everything under it.

/** The most paths one claim may list. */
export const MAX_CLAIM_PATHS = 50;

/** Whether `path` (a file) is covered by the claimed entry `entry`. */
export function inLaneEntry(path: string, entry: string) {
	if (entry.endsWith("/")) return path.startsWith(entry);
	return path === entry || path.startsWith(`${entry}/`);
}

/** Whether `path` is covered by any of the claimed entries. */
export const inLane = (path: string, owns: string[]) => owns.some((entry) => inLaneEntry(path, entry));

/** Whether two claimed entries can hold a common path. */
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

/** A change id from a title: its words, and a short random suffix so two changes never share one. */
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
