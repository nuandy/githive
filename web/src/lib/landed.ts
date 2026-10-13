import type { LandedChange } from "../api";

// What a branch's history (History's data: the changes landed, newest first) says beyond each change: the last one to
// touch a file, and which landed together.

/**
 * The newest landed change that touched `path`, if History lists one. It lists a change's first 20 files and the
 * branch's last 200 changes, and nothing pushed with plain git, so a file can be missing, or changed since by a commit
 * it doesn't list.
 */
export function lastChangeTo(path: string, changes: LandedChange[]): LandedChange | undefined {
	return changes.find((change) => change.files.includes(path));
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
