import { fail } from "../errors";
import { repoOfUrl } from "../git-http";
import { type CommitMeta, filesBetween, type HistorySource } from "./branch-history";
import { atMost, type BatchGit, type Inspected } from "./merge";
import type { BatchSource } from "./merge-types";
import { cachingHistory, forgetTrees } from "./tree-reads";
import { SizedCache } from "../sized-cache";

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

/** Changes' places on a branch, kept for the repo where every Worker instance can read them (see RepoCache). */
export interface SharedPlacements {
	read(branch: string, heads: string[]): Promise<Record<string, Placed>>;
	keep(branch: string, placed: Placed[]): Promise<void>;
}

/** Inspects a batch through Artifacts. `fallback`, the Gate's inspect, reads the changes this can't place. */
export function artifactsInspect(
	history: ReadHistory,
	project: string,
	fallback: BatchGit["inspect"],
	shared?: SharedPlacements,
): BatchGit["inspect"] {
	return async ({ base, branch, changes }) => {
		const chain = await branchChain(history, project, branch, base);
		if (!chain) return fallback({ base, branch, changes });
		const onBranch = positions(chain);
		// The batch's changes share most of their trees, so each is read once for all of them.
		const reads = cachingHistory(history);
		const where = `${project}|${branch}`;
		const known = await recall(shared, where, branch, changes);
		const inspected = await atMost(READS_AT_ONCE, changes, async (entry): Promise<Inspected | null> => {
			try {
				return await reads(entry.source ? repoOfUrl(entry.source.url) : project, (source) =>
					readChange(source, where, entry, chain, onBranch),
				);
			} catch (err) {
				return { change: entry.change, error: String(err) };
			}
		});
		await share(shared, branch, where, inspected, known);
		const unplaced = changes.filter((_, index) => inspected[index] === null);
		if (!unplaced.length) return inspected as Inspected[];
		const fetched = await fallback({ base, branch, changes: unplaced });
		const fromGate = (change: string): Inspected =>
			fetched.find((result) => result.change === change) ?? { change, error: "its branch couldn't be read" };
		return changes.map((change, index) => inspected[index] ?? fromGate(change.change));
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

/** Clears the cached chains, placements and trees, for tests whose repos share names. */
export const forgetChains = () => {
	chains.clear();
	placements.clear();
	forgetTrees();
};

// Each change head's place on a branch, as last worked out, for the isolate. A head's merge base with the branch, and
// the files it changed since, stay the same as the branch moves on, so gathering a batch, landing it and fetching a
// change ahead share one reading of each change.
const placements = new SizedCache<Placed>("placements", 2_000);

const placementKey = (where: string, head: string) => `${where}|${head}`;

/** A head's place as last worked out, if its merge base is still on this chain of the branch. */
function placedBefore(where: string, head: string, onBranch: Map<string, number>) {
	const kept = placements.get(placementKey(where, head));
	return kept && onBranch.has(kept.base.hash) ? kept : undefined;
}

function remember(where: string, placed: Placed) {
	placements.set(placementKey(where, placed.head.hash), placed);
}

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
		const keptTip = kept?.[0];
		if (kept && keptTip) {
			// Read only the commits on top of the cached chain, if that's all that changed.
			const newer = await history(project, (source) => source.log(branch, NEWER_PAGE, 0));
			const from = newer.findIndex((c) => c.hash === head);
			const joins = newer.findIndex((c) => c.hash === keptTip.hash);
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

// The places other Worker instances worked out for the heads the changes were last seen at, added to this
// isolate's. Returns the heads that were known before reading.
async function recall(shared: SharedPlacements | undefined, where: string, branch: string, changes: BatchSource[]) {
	const seen = changes.flatMap((change) => (change.seen ? [change.seen] : []));
	const known = new Set(seen.filter((head) => placements.has(placementKey(where, head))));
	const missing = seen.filter((head) => !known.has(head));
	if (!shared || !missing.length) return known;
	const stored = await shared.read(branch, missing).catch((err) => {
		console.error("reading the kept placements failed", String(err));
		return {};
	});
	for (const placed of Object.values(stored)) {
		remember(where, placed);
		known.add(placed.head.hash);
	}
	return known;
}

// Keeps the places worked out here for other Worker instances: a change left out of this batch is gathered again.
async function share(
	shared: SharedPlacements | undefined,
	branch: string,
	where: string,
	inspected: (Inspected | null)[],
	known: Set<string>,
) {
	if (!shared) return;
	const fresh = inspected.flatMap((each) => {
		const placed = each && "head" in each ? placements.get(placementKey(where, each.head)) : undefined;
		return placed && !known.has(placed.head.hash) ? [placed] : [];
	});
	if (fresh.length)
		await shared.keep(branch, fresh).catch((err) => console.error("keeping placements failed", String(err)));
}

async function readChange(
	source: HistorySource,
	where: string,
	entry: BatchSource,
	chain: CommitMeta[],
	onBranch: Map<string, number>,
): Promise<Inspected | null> {
	const { change } = entry;
	const placed = await placeChange(source, where, entry.ref, chain, onBranch, entry.seen);
	if (!placed) return null;
	if ("error" in placed) return { change, error: placed.error };
	return { change, head: placed.head.hash, files: placed.files };
}

// A change's head, its merge base with the branch and the files it changed since, or null if its history can't
// be placed. The merge base is the newest branch commit the change reaches, as git's merge-base finds it; agents
// merge the branch in rather than rebase. When the head it was last `seen` at is already placed, only the head is
// read, to see that it hasn't moved.
async function placeChange(
	source: HistorySource,
	where: string,
	ref: string,
	chain: CommitMeta[],
	onBranch: Map<string, number>,
	seen?: string,
): Promise<Placed | { error: string } | null> {
	const placedAsSeen = seen ? placedBefore(where, seen, onBranch) : undefined;
	if (placedAsSeen) {
		const [now] = await source.log(ref, 1, 0);
		if (now?.hash === seen) return placedAsSeen;
	}
	const own = await source.log(ref, CHANGE_WINDOW, 0);
	const head = own[0];
	if (!head) return { error: "its branch couldn't be read" };
	const known = placedBefore(where, head.hash, onBranch);
	if (known) return known;
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
	const base = newest === undefined ? undefined : chain[newest];
	if (!left || !base) return null;
	const placed = { head, base, files: await filesBetween(source, base.treeHash, head.treeHash) };
	remember(where, placed);
	return placed;
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
		placeChange(source, `${project}|${branch}`, change.ref, chain, onBranch),
	);
	if (!placed || "error" in placed) return placed;
	// What the branch changed since the change left it, or nothing if it hasn't moved.
	const branchTip = chain[0];
	const branchMoved = placed.base.hash !== main;
	let theirs: string[] = [];
	if (branchTip && branchMoved)
		theirs = await history(project, (source) => filesBetween(source, placed.base.treeHash, branchTip.treeHash));
	const touches = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
	return {
		head: placed.head.hash,
		files: placed.files,
		both: placed.files.filter((file) => theirs.some((theirFile) => touches(file, theirFile))),
	};
}

/**
 * Refuses a read that failed because Artifacts didn't answer. Reading the change with git instead would fetch the
 * project from the busiest repo, the more so the busier Artifacts is, so the caller is asked to come back.
 */
export function busyArtifacts(change: string, err: unknown): never {
	fail(503, `${change} couldn't be read just now, as Artifacts is busy (${String(err)}): call again shortly`);
}

/** A change placed on the branch: its head, its merge base with the branch, and the files it changed since. */
export type Placed = { head: CommitMeta; base: CommitMeta; files: string[] };

/**
 * Every change in a batch placed on the branch at `base`, with the branch's commit there, or null if any change
 * can't be placed exactly (only git can tell then), or couldn't be read.
 */
export async function placeBatch(
	history: ReadHistory,
	project: string,
	branch: string,
	base: string,
	changes: { ref: string; head?: string; source?: { url: string } }[],
): Promise<{ tip: CommitMeta; placed: Placed[] } | null> {
	const chain = await branchChain(history, project, branch, base);
	const tip = chain?.[0];
	if (!chain || !tip) return null;
	const onBranch = positions(chain);
	const where = `${project}|${branch}`;
	const placed = await atMost(READS_AT_ONCE, changes, async (change) => {
		// Gathering the batch, or fetching the change ahead, placed this head already.
		const known = change.head ? placedBefore(where, change.head, onBranch) : undefined;
		if (known) return known;
		return history(change.source ? repoOfUrl(change.source.url) : project, (source) =>
			placeChange(source, where, change.ref, chain, onBranch),
		).catch(() => null);
	});
	if (placed.some((each) => !each || "error" in each)) return null;
	return { tip, placed: placed as Placed[] };
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
