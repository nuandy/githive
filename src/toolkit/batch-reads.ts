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
export function artifactsInspect(
	history: ReadHistory,
	project: string,
	fallback: BatchGit["inspect"],
): BatchGit["inspect"] {
	return async ({ base, branch, changes }) => {
		const chain = await branchChain(history, project, branch, base);
		if (!chain) return fallback({ base, branch, changes });
		const onBranch = new Map(chain.map((c, i) => [c.hash, i]));
		const read = await atMost(READS_AT_ONCE, changes, async (c): Promise<Inspected | null> => {
			try {
				return await history(c.source ? repoOfUrl(c.source.url) : project, (source) =>
					readChange(source, c.change, c.ref, chain, onBranch),
				);
			} catch (err) {
				return { change: c.change, error: String(err) };
			}
		});
		const unplaced = changes.filter((_, i) => read[i] === null);
		if (!unplaced.length) return read as Inspected[];
		const fetched = await fallback({ base, branch, changes: unplaced });
		return read.map(
			(r, i) =>
				r ??
				fetched.find((f) => f.change === changes[i].change) ?? {
					change: changes[i].change,
					error: "its branch couldn't be read",
				},
		);
	};
}

/** How many commits are read first when the branch has moved on from the chain kept: the commits landed since, usually. */
const NEWER_PAGE = 64;

/**
 * Each branch's first-parent chain as last read, kept for the isolate: every
 * check and merge reads where its change left the branch, and the branch only
 * moves when a batch lands. Read for each of them, it was a log of 1,000
 * commits of the project repo a call.
 */
const chains = new Map<string, Promise<CommitMeta[] | null>>();
const CHAINS_KEPT = 16;

/** Forget the chains kept (tests, whose repos share names). */
export const forgetChains = () => chains.clear();

/**
 * The branch's first-parent chain from `head`, newest first (0: `head`), or
 * null if `head` isn't within the window read. As kept, if it's the head kept;
 * moved on from it, only the commits on top are read and the rest kept.
 */
async function branchChain(
	history: ReadHistory,
	project: string,
	branch: string,
	head: string,
): Promise<CommitMeta[] | null> {
	const key = `${project}|${branch}`;
	const kept = await chains.get(key)?.catch(() => null);
	// `head` on the chain kept: the branch as it was then (a head kept a moment by a caller, say), with nothing read.
	const at = kept?.findIndex((c) => c.hash === head) ?? -1;
	if (kept && at >= 0) return at === 0 ? kept : kept.slice(at);
	const reading = (async () => {
		if (kept?.length) {
			// The commits on top of the chain kept, if that's all that changed.
			const newer = await history(project, (source) => source.log(branch, NEWER_PAGE, 0));
			const from = newer.findIndex((c) => c.hash === head);
			const joins = newer.findIndex((c) => c.hash === kept[0].hash);
			if (from >= 0 && joins >= from) return [...newer.slice(from, joins), ...kept].slice(0, BRANCH_WINDOW);
		}
		const listed = await history(project, (source) => source.log(branch, BRANCH_WINDOW, 0));
		const from = listed.findIndex((c) => c.hash === head);
		return from < 0 ? null : listed.slice(from);
	})();
	chains.delete(key);
	chains.set(key, reading);
	while (chains.size > CHAINS_KEPT) chains.delete(chains.keys().next().value!);
	const chain = await reading.catch((err) => {
		chains.delete(key);
		throw err;
	});
	// Not kept unless it's the branch at `head`: a head the window doesn't reach is read again.
	if (!chain) chains.delete(key);
	return chain;
}

/** One change's head and files, or null if its history can't be placed (see placeChange). */
async function readChange(
	source: HistorySource,
	change: string,
	ref: string,
	chain: CommitMeta[],
	onBranch: Map<string, number>,
): Promise<Inspected | null> {
	const placed = await placeChange(source, ref, chain, onBranch);
	if (!placed) return null;
	if ("error" in placed) return { change, error: placed.error };
	return { change, head: placed.head.hash, files: placed.files };
}

/**
 * One change's head, its merge base with the branch, and the files it changed
 * since, or null if its history can't be placed: the merge base is the newest
 * branch commit it reaches, either where it left the branch or a branch commit
 * it merged in since (agents merge the branch in, never rebase), the way git's
 * merge-base finds it.
 */
async function placeChange(
	source: HistorySource,
	ref: string,
	chain: CommitMeta[],
	onBranch: Map<string, number>,
): Promise<{ head: CommitMeta; base: CommitMeta; files: string[] } | { error: string } | null> {
	const own = await source.log(ref, CHANGE_WINDOW, 0);
	const head = own[0];
	if (!head) return { error: "its branch couldn't be read" };
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
	return { head, base: chain[newest], files: await filesBetween(source, chain[newest].treeHash, head.treeHash) };
}

/**
 * A change against the branch at `main`, read through Artifacts' API: its
 * head, the files it changed since it left the branch, and those of them the
 * branch changed too since then (a file, or a folder one side replaced with a
 * file). None: it merges cleanly, git merging files only one side changed.
 * Some: it may conflict, and only a test merge can tell (the caller's). Null if
 * its history can't be placed (see placeChange); an error if its branch can't
 * be read. For an agent's check and its merge, which test-merged every change
 * in memory, fetching main from the project repo: at 1,000 agents, the project
 * repo failed 4,000 of those requests (run 1000-1).
 */
export async function changeAgainst(
	history: ReadHistory,
	project: string,
	branch: string,
	main: string,
	change: { ref: string; source?: { url: string } },
): Promise<{ head: string; files: string[]; both: string[] } | { error: string } | null> {
	const chain = await branchChain(history, project, branch, main);
	if (!chain) return null;
	const onBranch = new Map(chain.map((c, i) => [c.hash, i]));
	const placed = await history(change.source ? repoOfUrl(change.source.url) : project, (source) =>
		placeChange(source, change.ref, chain, onBranch),
	);
	if (!placed || "error" in placed) return placed;
	// What the branch changed since the change left it: none if it hasn't moved since.
	const theirs =
		placed.base.hash === main
			? []
			: await history(project, (source) => filesBetween(source, placed.base.treeHash, chain[0].treeHash));
	const touches = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
	return {
		head: placed.head.hash,
		files: placed.files,
		both: placed.files.filter((f) => theirs.some((t) => touches(f, t))),
	};
}

/**
 * Which of `heads` the branch at `main` merged already, each with the merge
 * commit that did (one whose second parent it is), from the branch's history
 * as kept (see branchChain): a batch's push a busy repo answered with a server
 * error though it applied left its changes on main, their claims held and
 * their landing unrecorded, and every batch after took one of them up, merged
 * it to nothing and failed (run 1000-4).
 */
export async function landedOn(
	history: ReadHistory,
	project: string,
	branch: string,
	main: string,
	heads: string[],
): Promise<Map<string, string>> {
	const on = new Map<string, string>();
	const chain = await branchChain(history, project, branch, main);
	if (!chain || !heads.length) return on;
	const wanted = new Set(heads);
	for (const commit of chain)
		for (const merged of commit.parents.slice(1))
			if (wanted.has(merged) && !on.has(merged)) on.set(merged, commit.hash);
	return on;
}
