import type { ReadHistory } from "./batch-reads";
import type { TreeEntry } from "./branch-history";

// Tree reads for a landing. A batch's changes mostly share their merge base and the folders near the top, so reading
// each tree only once, and only along the paths that matter, keeps a landing to a few reads per change.

// Trees as read or written, for the isolate. Gathering a batch, landing it and fetching a change ahead read the same
// trees, and a landing's last tree is where the next one starts. Only finished reads are kept: a read still under
// way belongs to the request that started it.
const keptTrees = new Map<string, TreeEntry[]>();
// About 10 MB of entries.
const ENTRIES_KEPT = 50_000;
let entriesKept = 0;

/** Keeps a tree read or written, by its hash, for any later reads in the isolate. */
export function keepTree(hash: string, entries: TreeEntry[]) {
	if (keptTrees.has(hash)) return;
	keptTrees.set(hash, entries);
	entriesKept += entries.length;
	for (const [oldest, kept] of keptTrees) {
		if (entriesKept <= ENTRIES_KEPT) break;
		keptTrees.delete(oldest);
		entriesKept -= kept.length;
	}
}

function keptTree(hash: string) {
	const kept = keptTrees.get(hash);
	if (!kept) return undefined;
	// Most recently used last, so the oldest go first.
	keptTrees.delete(hash);
	keptTrees.set(hash, kept);
	return kept;
}

/** Forgets the kept trees, for tests whose made-up hashes differ in content from one test to the next. */
export function forgetTrees() {
	keptTrees.clear();
	entriesKept = 0;
}

/**
 * `history` with each tree read at most once. Git names a tree by its content, so one read serves every repo that
 * has the tree, the project and its forks alike, and every request in the isolate.
 */
export function cachingHistory(history: ReadHistory): ReadHistory {
	const reading = new Map<string, Promise<TreeEntry[] | null>>();
	const once = (hash: string, read: () => Promise<TreeEntry[] | null>) => {
		const kept = keptTree(hash);
		if (kept) return Promise.resolve(kept);
		const started = reading.get(hash);
		if (started) return started;
		const pending = read();
		reading.set(hash, pending);
		// A failed read, or a tree this repo doesn't have, may be read again from another.
		pending
			.then((entries) => (entries ? keepTree(hash, entries) : undefined))
			.catch(() => undefined)
			.finally(() => reading.delete(hash));
		return pending;
	};
	return (repo, read) =>
		history(repo, (source) =>
			read({
				log: (ref, limit, offset) => source.log(ref, limit, offset),
				readCommit: (hash) => source.readCommit(hash),
				readTree: (hash) => once(hash, () => source.readTree(hash)),
			}),
		);
}

type ReadTree = (hash: string) => Promise<TreeEntry[] | null>;

/**
 * The entry at `path` in a tree, or the file standing where a folder on the way to it would be, or null if there's
 * neither. A file in the way is returned so that it differs from a tree where the path is simply absent.
 */
export async function entryAt(readTree: ReadTree, tree: string, path: string): Promise<TreeEntry | null> {
	const segments = path.split("/");
	let entries = (await readTree(tree)) ?? [];
	for (const [index, name] of segments.entries()) {
		const entry = entries.find((each) => each.name === name);
		if (!entry || index === segments.length - 1) return entry ?? null;
		if (entry.type !== "tree") return entry;
		entries = (await readTree(entry.hash)) ?? [];
	}
	return null;
}

/**
 * Which of `files` the branch changed between the trees `from` and `to`: the entry at the path, or a folder or file
 * standing in its way, differs. This reads only the trees along those paths, not everything the branch changed.
 */
export async function changedAlong(readTree: ReadTree, from: string, to: string, files: string[]) {
	const same = (a: TreeEntry | null, b: TreeEntry | null) => a?.hash === b?.hash && a?.mode === b?.mode;
	const changed = await Promise.all(
		files.map(async (file) => {
			const [before, after] = await Promise.all([entryAt(readTree, from, file), entryAt(readTree, to, file)]);
			return same(before, after) ? null : file;
		}),
	);
	return changed.filter((file): file is string => file !== null);
}
