// Small helpers the dashboard's pages share: times, commits and path lists.

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

/** A list of paths for a one-line summary: the first few, then how many more. */
export function briefPaths(paths: string[], shown = 3): string {
	return paths.length > shown ? `${paths.slice(0, shown).join(", ")} +${paths.length - shown} more` : paths.join(", ");
}
