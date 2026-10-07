// The format GitHive's records are in: the shape of each record log's state
// (claims, shards, votes, the backlog, change indexes) and of the trailers on
// merge and revert commits. Every record commit says its format in a trailer;
// records from before formats were written down have none and are format 1.
//
// Changing a record's shape: bump RECORD_FORMAT, add UPGRADES[old] turning a
// state of the old format into the new one (a log's ref says which record it
// is), and update test/fixtures/record-shapes.json. Readers upgrade old states
// as they read; writers always write the current format; a GitHive that meets
// records newer than it knows reads them as they are and won't write over
// them, so rolling back can't corrupt them.

export const RECORD_FORMAT = 1;
export const FORMAT_TRAILER = "GitHive-Format";

/** Turns a state of one format into the next, given the ref of the log it's in. */
export type Upgrade = (state: unknown, ref: string) => unknown;

/** UPGRADES[n]: format n to n + 1. None yet: format 1 is the first written down. */
export const UPGRADES: Readonly<Record<number, Upgrade>> = {};

/** A commit's record format, from its trailer; none means format 1. */
export function formatOf(message: string): number {
	const found = message.match(new RegExp(`^${FORMAT_TRAILER}: (\\d+)$`, "m"))?.[1];
	return found ? Number(found) : 1;
}

/** A state of format `from`, upgraded to `to` one format at a time. */
export function upgradeState<S>(state: unknown, from: number, ref: string, to: number = RECORD_FORMAT, upgrades: Readonly<Record<number, Upgrade>> = UPGRADES): S {
	let current = state;
	for (let f = from; f < to; f++) {
		const upgrade = upgrades[f];
		if (!upgrade) throw new Error(`[500] no upgrade from record format ${f} to ${f + 1}`);
		current = upgrade(current, ref);
	}
	return current as S;
}

/** Refusing to write over records a newer GitHive wrote. */
export function newerFormat(found: number, known: number = RECORD_FORMAT) {
	return new Error(`[409] these records are format ${found}, newer than this GitHive knows (${known}): it reads them but won't write over them`);
}
