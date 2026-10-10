import { repoOfUrl } from "../git-http";
import { type CommitMeta, filesBetween, type HistorySource } from "./branch-history";
import { atMost, type BatchGit, type Inspected } from "./merge";

// A batch's changes read through Artifacts' own API (log, readTree), in the
// Worker, not fetched in the repo's Gate: each change's head, and the files it
// changed since it left the branch, from its fork's history and a comparison
// of two trees. No Git client, no clone, nothing held in memory but a few
// trees: reading 1 to 4 changes took 1.6 to 3.1 s (agents-6), where the Gate
// took 10 to 23 s (agents-7, its container restarting between batches). A
// change whose history this can't place exactly (it merged in something that
// isn't the branch, or left it longer ago than the window read) is read in the
// Gate as before (`fallback`): what git's merge-base would say, either way.
// The batch still lands in the Gate.

/** Read a repo's history (by its name in Artifacts) through Artifacts' API. */
export type ReadHistory = <T>(repo: string, read: (source: HistorySource) => Promise<T>) => Promise<T>;

/** How much of the branch's history a batch reads (Artifacts' most in one call): a change left the branch within it, or is read in the Gate. */
const BRANCH_WINDOW = 1000;
/** How much of a change's own history is read for where it left the branch: past this, it's read in the Gate. */
const CHANGE_WINDOW = 200;
/** How many changes are read at once. */
const READS_AT_ONCE = 6;

/**
 * A batch's inspect through Artifacts: `project` is the project repo's name,
 * each change's branch is in its source's repo (its fork), and `fallback`
 * (the Gate's) reads the changes this can't place.
 */
export function artifactsInspect(history: ReadHistory, project: string, fallback: BatchGit["inspect"]): BatchGit["inspect"] {
	return async ({ base, branch, changes }) => {
		// The branch's first-parent chain from `base`, newest first: where each commit is on it (0: base).
		const listed = await history(project, (source) => source.log(branch, BRANCH_WINDOW, 0));
		const from = listed.findIndex((c) => c.hash === base);
		if (from < 0) return fallback({ base, branch, changes });
		const chain = listed.slice(from);
		const onBranch = new Map(chain.map((c, i) => [c.hash, i]));
		const read = await atMost(READS_AT_ONCE, changes, async (c): Promise<Inspected | null> => {
			try {
				return await history(c.source ? repoOfUrl(c.source.url) : project, (source) => readChange(source, c.change, c.ref, chain, onBranch));
			} catch (err) {
				return { change: c.change, error: String(err) };
			}
		});
		const unplaced = changes.filter((_, i) => read[i] === null);
		if (!unplaced.length) return read as Inspected[];
		const fetched = await fallback({ base, branch, changes: unplaced });
		return read.map((r, i) => r ?? fetched.find((f) => f.change === changes[i].change) ?? { change: changes[i].change, error: "its branch couldn't be read" });
	};
}

/**
 * One change's head and files, or null if its history can't be placed: its
 * merge base with the branch is the newest branch commit it reaches, either
 * where it left the branch or a branch commit it merged in since (agents merge
 * the branch in, never rebase), the way git's merge-base finds it.
 */
async function readChange(source: HistorySource, change: string, ref: string, chain: CommitMeta[], onBranch: Map<string, number>): Promise<Inspected | null> {
	const own = await source.log(ref, CHANGE_WINDOW, 0);
	const head = own[0];
	if (!head) return { change, error: "its branch couldn't be read" };
	let newest: number | undefined;
	const reached = (i: number) => (newest = newest === undefined ? i : Math.min(newest, i));
	let left = false;
	for (const commit of own) {
		const at = onBranch.get(commit.hash);
		if (at !== undefined) {
			reached(at);
			left = true;
			break;
		}
		for (const merged of commit.parents.slice(1)) {
			const where = onBranch.get(merged);
			// Merged in something that isn't the branch (another change, an older line): only git can say.
			if (where === undefined) return null;
			reached(where);
		}
	}
	if (!left || newest === undefined) return null;
	return { change, head: head.hash, files: await filesBetween(source, chain[newest].treeHash, head.treeHash) };
}
