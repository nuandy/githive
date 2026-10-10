// The shape of GitHive's records, named in a trailer on every record commit (none means format 1).
// To change a shape, bump RECORD_FORMAT, add UPGRADES[old] and update test/fixtures/record-shapes.json.
// A GitHive never overwrites records newer than it knows, so rolling back can't corrupt them.

export const RECORD_FORMAT = 1;
export const FORMAT_TRAILER = "GitHive-Format";

/** Turns a state of one format into the next. The ref says which record it is. */
export type Upgrade = (state: unknown, ref: string) => unknown;

/** UPGRADES[n] turns format n into n + 1. */
export const UPGRADES: Readonly<Record<number, Upgrade>> = {};

export function formatOf(message: string): number {
	const found = message.match(new RegExp(`^${FORMAT_TRAILER}: (\\d+)$`, "m"))?.[1];
	return found ? Number(found) : 1;
}

export function upgradeState<S>(
	state: unknown,
	from: number,
	ref: string,
	to: number = RECORD_FORMAT,
	upgrades: Readonly<Record<number, Upgrade>> = UPGRADES,
): S {
	let current = state;
	for (let format = from; format < to; format++) {
		const upgrade = upgrades[format];
		if (!upgrade) throw new Error(`[500] no upgrade from record format ${format} to ${format + 1}`);
		current = upgrade(current, ref);
	}
	return current as S;
}

export function newerFormat(found: number, known: number = RECORD_FORMAT) {
	return new Error(
		`[409] these records are format ${found}, newer than this GitHive knows (${known}): it reads them ` +
			"but won't write over them",
	);
}
