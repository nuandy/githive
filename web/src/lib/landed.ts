import type { LandedChange } from "../api";
import { counted } from "./plural";

// What a branch's history (History's data: the changes landed, newest first) says beyond each change: the last one to
// touch a file, and which landed together.

/** The most files History lists for a change. */
const FILES_LISTED = 20;

/**
 * Whether a change's file list is cut short: it changed more files than it lists. An older server doesn't say how
 * many, so a list as long as one gets may be.
 */
export const filesCut = (change: Pick<LandedChange, "files" | "filesTotal">) =>
	change.filesTotal !== undefined ? change.filesTotal > change.files.length : change.files.length >= FILES_LISTED;

/** The last landed change to touch a file, and why History can't be sure it's the last, if it can't. */
export interface LastChange {
	change: LandedChange;
	/**
	 * "cut": a newer change's file list is cut short, so it may have touched the file too. "unlisted": commits History
	 * doesn't list (pushed with plain git, a revert) reached the branch since, and may have.
	 */
	unsure?: "cut" | "unlisted";
}

/**
 * The newest landed change that touched `path`, if History lists one (it lists the branch's last 200), and whether
 * History can be sure of it.
 */
export function lastChangeTo(path: string, changes: LandedChange[]): LastChange | undefined {
	const at = changes.findIndex((change) => change.files.includes(path));
	if (at < 0) return undefined;
	const change = changes[at]!;
	if (change.unlistedSince) return { change, unsure: "unlisted" };
	if (changes.slice(0, at).some(filesCut)) return { change, unsure: "cut" };
	return { change };
}

/** Changes that landed together, newest first, and when; a change that landed on its own is a batch of one. */
export interface Batch {
	at?: string;
	changes: LandedChange[];
}

/**
 * The changes in their batches. A batch lands in one push, and the server notes one time for all of it, so changes
 * next to each other with the same time landed together. A change whose time the landing no longer recalls is on its
 * own.
 */
export function batchesOf(changes: LandedChange[]): Batch[] {
	const batches: Batch[] = [];
	for (const change of changes) {
		const last = batches.at(-1);
		if (change.at && last?.at === change.at) last.changes.push(change);
		else batches.push({ ...(change.at ? { at: change.at } : {}), changes: [change] });
	}
	return batches;
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** A batch's quiet heading: "Landed together at 14:02 · 3 changes", with its date on another day than today. */
export function batchWords(at: string, count: number, now: number | Date = Date.now()): string {
	const when = new Date(at);
	const time = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`;
	const today = when.toDateString() === new Date(now).toDateString();
	const day = today ? "" : ` on ${when.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
	return `Landed together${day} at ${time} · ${counted(count, "change")}`;
}
