import type { ReadHistory } from "./batch-reads";
import type { BLOB_TOO_LARGE, TreeEntry } from "./branch-history";
import { SizedCache } from "../sized-cache";

// Tree reads for a landing. A batch's changes mostly share their merge base and the folders near the top, so reading
// each tree only once, and only along the paths that matter, keeps a landing to a few reads per change.

// Trees as read or written, for the isolate. Gathering a batch, landing it and fetching a change ahead read the same
// trees, and a landing's last tree is where the next one starts. Only finished reads are kept: a read still under
// way belongs to the request that started it.
// About 10 MB of entries.
const keptTrees = new SizedCache<TreeEntry[]>("trees", 50_000);

/** Keeps a tree read or written, by its hash, for any later reads in the isolate. */
export function keepTree(hash: string, entries: TreeEntry[]) {
	if (!keptTrees.has(hash)) keptTrees.set(hash, entries, entries.length);
}

const keptTree = (hash: string) => keptTrees.get(hash);

// Blobs as read, for the isolate, the same way. Blobs never change either.
const keptBlobs = new SizedCache<Uint8Array>("blobs", 8 * 1024 * 1024, "bytes");

/** Forgets the kept trees and blobs, for tests whose made-up hashes differ in content from one test to the next. */
export function forgetTrees() {
	keptTrees.clear();
	keptBlobs.clear();
}

/**
 * `history` with each tree and blob read at most once. Git names them by their content, so one read serves every
 * repo that has them, the project and its forks alike, and every request in the isolate.
 */
export function cachingHistory(history: ReadHistory): ReadHistory {
	const tree = readsOnce(keptTree, keepTree);
	const blob = readsOnce<Uint8Array | typeof BLOB_TOO_LARGE>(
		(hash) => keptBlobs.get(hash),
		(hash, bytes) => {
			if (bytes instanceof Uint8Array) keptBlobs.set(hash, bytes, bytes.byteLength);
		},
	);
	return (repo, read) =>
		history(repo, (source) => {
			const readBlob = source.readBlob?.bind(source);
			// Reads with different caps are told apart, so one never gets another's BLOB_TOO_LARGE.
			const readCapped = (hash: string, maxBytes?: number) =>
				blob(hash, () => readBlob!(hash, maxBytes), `:${maxBytes ?? ""}`);
			return read({
				log: (ref, limit, offset) => source.log(ref, limit, offset),
				readCommit: (hash) => source.readCommit(hash),
				readTree: (hash) => tree(hash, () => source.readTree(hash)),
				...(readBlob ? { readBlob: readCapped } : {}),
			});
		});
}

// Reads by hash, each at most once at a time, answered from what's kept when it can be. Reads of the same hash that
// may answer differently pass a `variant`.
function readsOnce<V>(kept: (hash: string) => V | undefined, keep: (hash: string, value: V) => void) {
	const reading = new Map<string, Promise<V | null>>();
	return (hash: string, read: () => Promise<V | null>, variant = "") => {
		const hit = kept(hash);
		if (hit) return Promise.resolve(hit);
		const key = hash + variant;
		const started = reading.get(key);
		if (started) return started;
		const pending = read();
		reading.set(key, pending);
		// A failed read, or an object this repo doesn't have, may be read again from another.
		pending
			.then((value) => (value ? keep(hash, value) : undefined))
			.catch(() => undefined)
			.finally(() => reading.delete(key));
		return pending;
	};
}

type ReadTree = (hash: string) => Promise<TreeEntry[] | null>;

/** Reads `repo`'s trees, answering those kept for the isolate without opening the repo. */
export function treesOf(history: ReadHistory, repo: string): ReadTree {
	return async (hash) => keptTree(hash) ?? (await history(repo, (source) => source.readTree(hash)));
}

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
