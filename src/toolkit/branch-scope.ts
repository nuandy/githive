// Claims are per target branch: lib/auth/ on main and lib/auth/ on
// release/2.x are different code, and two changes holding them don't
// conflict. The claims records keep a claim into a branch other than the
// project's under a first path segment of its own (::<branch>), so every
// rule that works on paths (overlap, shards, stale claims, the audit's
// coverage) keeps branches apart with no rule of its own. A claim into the
// project's branch has no such segment, as every claim made before branches.
//
// Agents never see the segment: the tools take paths and `into`, and give
// back the same. Nobody may claim a path that starts with it themselves.

const MARK = "::";

/** The segment a branch's claims are kept under. */
const segmentOf = (branch: string) => `${MARK}${encodeURIComponent(branch)}`;

/** Whether a path (as an agent gave it) is in the segment reserved for branches. */
export const isReservedPath = (path: string) => path.startsWith(MARK);

/** Paths as the claims records keep them, for a change into `into` (the project's `branch`, or another). */
export function scopePaths(paths: string[], into: string, branch: string): string[] {
	return into === branch ? paths : paths.map((path) => `${segmentOf(into)}/${path}`);
}

/** A file, as a merge into `into` touches it, in the claims records' terms. */
export const scopeFile = (file: string, into: string, branch: string) => (into === branch ? file : `${segmentOf(into)}/${file}`);

/** A path as the claims records keep it: which branch it's in (the project's, `branch`, when it has no segment) and the path in it. */
export function unscopePath(path: string, branch: string): { into: string; path: string } {
	if (!isReservedPath(path)) return { into: branch, path };
	const slash = path.indexOf("/");
	return { into: decodeURIComponent(path.slice(MARK.length, slash < 0 ? undefined : slash)), path: slash < 0 ? "" : path.slice(slash + 1) };
}

/** The branch a claim's change targets: the one its paths are kept under. */
export const claimInto = (claim: { paths: string[] }, branch: string) => (claim.paths.length ? unscopePath(claim.paths[0], branch).into : branch);

/** A claim as agents see it: its paths without the segment, and `into` when it isn't the project's branch. */
export function presentClaim<C extends { paths: string[] }>(claim: C, branch: string): C & { into?: string } {
	const into = claimInto(claim, branch);
	if (into === branch) return claim;
	return { ...claim, paths: claim.paths.map((p) => unscopePath(p, branch).path), into };
}
