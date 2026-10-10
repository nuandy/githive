// Small helpers the dashboard's pages share: times, commits and path lists.

/** Milliseconds since epoch, or undefined for a missing/invalid timestamp. */
export function timeOf(iso: string | undefined | null): number | undefined {
	if (!iso) return undefined;
	const timestamp = Date.parse(iso);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** The latest of several timestamps, as given (ISO), or undefined if none is valid. */
export function latest(...times: (string | undefined | null)[]): string | undefined {
	let best: string | undefined;
	let bestTimestamp = -Infinity;
	for (const time of times) {
		const timestamp = timeOf(time);
		if (timestamp !== undefined && timestamp > bestTimestamp) {
			best = time!;
			bestTimestamp = timestamp;
		}
	}
	return best;
}

export const shortSha = (commit: string | undefined | null) => (commit ? commit.slice(0, 7) : "");

/** A list of paths for a one-line summary: the first few, then how many more. */
export function briefPaths(paths: string[], shown = 3): string {
	if (paths.length <= shown) return paths.join(", ");
	const first = paths.slice(0, shown).join(", ");
	const more = paths.length - shown;
	return `${first} +${more} more`;
}
