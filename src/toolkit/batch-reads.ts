import { repoOfUrl } from "../git-http";
import { type CommitMeta, filesBetween, type HistorySource } from "./branch-history";
import { atMost, type BatchGit, type Inspected } from "./merge";

// Reads a batch's changes through the Artifacts API in the Worker instead of fetching them in the repo's Gate:
// each change's head, and the files it changed since leaving the branch, from comparing two trees. This is much
// faster than the Gate and holds only a few trees in memory. A change whose history this can't place exactly is
// read in the Gate instead, so the answer always matches git's merge-base. The batch still lands in the Gate.

export type ReadHistory = <T>(repo: string, read: (source: HistorySource) => Promise<T>) => Promise<T>;

// How much branch history a batch reads, the Artifacts maximum per call. A change that left the branch earlier
// is read in the Gate.
const BRANCH_WINDOW = 1000;
// How far back a change's own history is searched for where it left the branch.
const CHANGE_WINDOW = 200;
const READS_AT_ONCE = 6;

/** Inspects a batch through Artifacts. `fallback`, the Gate's inspect, reads the changes this can't place. */
export function artifactsInspect(
	history: ReadHistory,
	project: string,
	fallback: BatchGit["inspect"],
): BatchGit["inspect"] {
	return async ({ base, branch, changes }) => {
		const chain = await branchChain(history, project, branch, base);
		if (!chain) return fallback({ base, branch, changes });
		const onBranch = positions(chain);
		const inspected = await atMost(READS_AT_ONCE, changes, async (entry): Promise<Inspected | null> => {
			try {
				return await history(entry.source ? repoOfUrl(entry.source.url) : project, (source) =>
					readChange(source, entry.change, entry.ref, chain, onBranch),
				);
			} catch (err) {
				return { change: entry.change, error: String(err) };
			}
		});
		const unplaced = changes.filter((_, index) => inspected[index] === null);
		if (!unplaced.length) return inspected as Inspected[];
		const fetched = await fallback({ base, branch, changes: unplaced });
		const fromGate = (change: string): Inspected =>
			fetched.find((result) => result.change === change) ?? { change, error: "its branch couldn't be read" };
		return inspected.map((result, index) => result ?? fromGate(changes[index].change));
	};
}

// Each commit's index on the chain, newest first.
const positions = (chain: CommitMeta[]) => new Map(chain.map((commit, index) => [commit.hash, index]));

// When the branch has moved past the cached chain, this many commits usually cover what landed since.
const NEWER_PAGE = 64;

// Each branch's first-parent chain as last read, cached for the isolate. Every check and merge needs it and the
// branch only moves when a batch lands, so reading it per call cost a full log of the project repo each time.
const chains = new Map<string, Promise<CommitMeta[] | null>>();
const CHAINS_KEPT = 16;

/** Clears the cached chains, for tests whose repos share names. */
export const forgetChains = () => chains.clear();

// The branch's first-parent chain from `head`, newest first, or null if `head` is outside the window. When the
// branch has moved past the cached chain, only the new commits are read.
async function branchChain(
	history: ReadHistory,
	project: string,
	branch: string,
	head: string,
): Promise<CommitMeta[] | null> {
	const key = `${project}|${branch}`;
	const kept = await chains.get(key)?.catch(() => null);
	// `head` is already on the cached chain, for example a briefly cached head from a caller.
	const at = kept?.findIndex((c) => c.hash === head) ?? -1;
	if (kept && at >= 0) return at === 0 ? kept : kept.slice(at);
	const reading = (async () => {
		if (kept?.length) {
			// Read only the commits on top of the cached chain, if that's all that changed.
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
	// Don't cache a miss, so a head outside the window is read again next time.
	if (!chain) chains.delete(key);
	return chain;
}

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

// A change's head, its merge base with the branch and the files it changed since, or null if its history can't
// be placed. The merge base is the newest branch commit the change reaches, as git's merge-base finds it; agents
// merge the branch in rather than rebase.
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
	const reached = (index: number) => {
		newest = newest === undefined ? index : Math.min(newest, index);
	};
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
			// It merged in something other than the branch, such as another change, so only git can tell.
			if (where === undefined) return null;
			reached(where);
		}
	}
	if (!left || newest === undefined) return null;
	return { head, base: chain[newest], files: await filesBetween(source, chain[newest].treeHash, head.treeHash) };
}

/**
 * A change against the branch at `main`: its head, its changed files, and those the branch also changed since
 * (`both`). An empty `both` means a clean merge; otherwise only a test merge can tell. This spares checks and
 * merges a fetch of main from the project repo, which failed often under load.
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
	const onBranch = positions(chain);
	const placed = await history(change.source ? repoOfUrl(change.source.url) : project, (source) =>
		placeChange(source, change.ref, chain, onBranch),
	);
	if (!placed || "error" in placed) return placed;
	// What the branch changed since the change left it, or nothing if it hasn't moved.
	const theirs =
		placed.base.hash === main
			? []
			: await history(project, (source) => filesBetween(source, placed.base.treeHash, chain[0].treeHash));
	const touches = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
	return {
		head: placed.head.hash,
		files: placed.files,
		both: placed.files.filter((file) => theirs.some((theirFile) => touches(file, theirFile))),
	};
}

/**
 * Which of `heads` the branch at `main` already merged, each with its merge commit. A busy repo can answer a
 * push with a server error even though it applied, and later batches then took those changes up again and failed.
 */
export async function landedOn(
	history: ReadHistory,
	project: string,
	branch: string,
	main: string,
	heads: string[],
): Promise<Map<string, string>> {
	const landed = new Map<string, string>();
	const chain = await branchChain(history, project, branch, main);
	if (!chain || !heads.length) return landed;
	const wanted = new Set(heads);
	for (const commit of chain)
		for (const merged of commit.parents.slice(1))
			if (wanted.has(merged) && !landed.has(merged)) landed.set(merged, commit.hash);
	return landed;
}
