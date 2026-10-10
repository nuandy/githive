// Claims are per target branch: lib/auth/ on main and on release/2.x don't conflict. A claim into a branch other
// than the project's is stored under a leading ::<branch> path segment, so every path-based rule (overlap, shards,
// stale claims, audit coverage) keeps branches apart. Agents never see the segment, and nobody may claim under it.

const MARK = "::";

const segmentOf = (branch: string) => `${MARK}${encodeURIComponent(branch)}`;

export const isReservedPath = (path: string) => path.startsWith(MARK);

/** Paths as the claims records store them, for a change into `into`. */
export function scopePaths(paths: string[], into: string, branch: string): string[] {
	return into === branch ? paths : paths.map((path) => `${segmentOf(into)}/${path}`);
}

export const scopeFile = (file: string, into: string, branch: string) =>
	into === branch ? file : `${segmentOf(into)}/${file}`;

/** Splits a stored path into its target branch and the path within that branch. */
export function unscopePath(path: string, branch: string): { into: string; path: string } {
	if (!isReservedPath(path)) return { into: branch, path };
	const slash = path.indexOf("/");
	return {
		into: decodeURIComponent(path.slice(MARK.length, slash < 0 ? undefined : slash)),
		path: slash < 0 ? "" : path.slice(slash + 1),
	};
}

export const claimInto = (claim: { paths: string[] }, branch: string) =>
	claim.paths.length ? unscopePath(claim.paths[0], branch).into : branch;

/** A claim as agents see it: paths without the segment, plus `into` when it isn't the project's branch. */
export function presentClaim<C extends { paths: string[] }>(claim: C, branch: string): C & { into?: string } {
	const into = claimInto(claim, branch);
	if (into === branch) return claim;
	return { ...claim, paths: claim.paths.map((p) => unscopePath(p, branch).path), into };
}

/** The branch stored paths belong to, or undefined for the project's branch. */
export const scopedInto = (paths: string[]) =>
	paths[0] && isReservedPath(paths[0])
		? decodeURIComponent(paths[0].slice(MARK.length, paths[0].indexOf("/") < 0 ? undefined : paths[0].indexOf("/")))
		: undefined;
