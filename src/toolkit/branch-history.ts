import type { BranchCommit } from "./git-records";
import { atMost } from "./merge";

// A branch's history as the audit reads it, through the Artifacts API rather than a clone: the first-parent
// chain from log, and each commit's changed files from comparing trees, reading only the folders that differ.
// Cloning in a Worker was too slow and used most of its memory. A commit's files never change, so each is worked
// out once and cached (see KeptFiles), and later audits only read trees for new merges.

/** A commit as the Artifacts API decodes it. */
export interface CommitMeta {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string };
	parents: string[];
}

export interface TreeEntry {
	name: string;
	mode: string;
	hash: string;
	type: string;
}

/** The Artifacts API calls the audit reads a repo through. */
export interface HistorySource {
	/** The first-parent chain from `ref`, newest first: `limit` commits after the first `offset`. */
	log(ref: string, limit: number, offset: number): Promise<CommitMeta[]>;
	readCommit(hash: string): Promise<CommitMeta | null>;
	readTree(hash: string): Promise<TreeEntry[] | null>;
}

/** A cache of each commit's files changed from its first parent. Commits never change, so entries never expire. */
export interface KeptFiles {
	get(commits: string[]): Promise<Record<string, string[]>>;
	put(files: Record<string, string[]>): Promise<void>;
}

// The most commits one Artifacts log call returns.
const LOG_PAGE = 1000;
const DIFFS_AT_ONCE = 6;

/**
 * `branch`'s first-parent commits after `baseline`, oldest first, with their sorted changed files. This is what
 * `git log --first-parent baseline..branch` with `git diff-tree -r --name-only` would report.
 */
export async function readBranchHistory(
	source: HistorySource,
	baseline: string,
	branch: string,
	kept?: KeptFiles,
): Promise<BranchCommit[]> {
	const chain: CommitMeta[] = [];
	let reached = false;
	// Page until the baseline or an empty page. A short page isn't taken as the end, so a smaller server cap
	// can't silently drop history from the audit.
	for (let offset = 0; !reached;) {
		const page = await source.log(branch, LOG_PAGE, offset);
		if (!page.length) break;
		for (const commit of page) {
			if (commit.hash === baseline) {
				reached = true;
				break;
			}
			chain.push(commit);
		}
		offset += page.length;
	}
	chain.reverse();
	const known =
		kept && chain.length ? await kept.get(chain.map((c) => c.hash)).catch(() => ({}) as Record<string, string[]>) : {};
	// A commit's first parent is the previous commit in the chain, or the baseline for the first one.
	const trees = new Map(chain.map((c) => [c.hash, c.treeHash]));
	const missing = chain.filter((c) => !known[c.hash]);
	const first = missing.find((c) => c.parents[0] && !trees.has(c.parents[0]));
	if (first?.parents[0]) {
		const parent = await source.readCommit(first.parents[0]);
		if (parent) trees.set(parent.hash, parent.treeHash);
	}
	const read = new Map<string, Promise<TreeEntry[]>>();
	const tree = (hash: string) => {
		if (!read.has(hash))
			read.set(
				hash,
				source.readTree(hash).then((entries) => entries ?? []),
			);
		return read.get(hash)!;
	};
	const worked = await atMost(DIFFS_AT_ONCE, missing, async (c) => {
		const before = c.parents[0] ? trees.get(c.parents[0]) : undefined;
		if (c.parents[0] && !before)
			throw new Error(`${c.hash}'s first parent ${c.parents[0]} isn't on ${branch}'s history`);
		return [c.hash, (await changedFiles(tree, before ?? null, c.treeHash)).sort()] as const;
	});
	const files = { ...known, ...Object.fromEntries(worked) };
	if (kept && worked.length) await kept.put(Object.fromEntries(worked)).catch(() => undefined);
	return chain.map((c) => ({
		commit: c.hash,
		parents: c.parents,
		author: c.author.name,
		message: c.message.replace(/\n+$/, ""),
		files: files[c.hash] ?? [],
	}));
}

/** The sorted paths that differ between trees `a` and `b`, where null is an empty tree. */
export async function filesBetween(source: HistorySource, a: string | null, b: string | null): Promise<string[]> {
	const read = new Map<string, Promise<TreeEntry[]>>();
	const tree = (hash: string) => {
		if (!read.has(hash))
			read.set(
				hash,
				source.readTree(hash).then((entries) => entries ?? []),
			);
		return read.get(hash)!;
	};
	return (await changedFiles(tree, a, b)).sort();
}

// Reads only the folders whose hashes differ. Matches `git diff-tree -r --name-only`: a mode change counts, and a
// folder replaced by a file lists both.
async function changedFiles(
	tree: (hash: string) => Promise<TreeEntry[]>,
	a: string | null,
	b: string | null,
	prefix = "",
): Promise<string[]> {
	if (a === b) return [];
	const [before, after] = await Promise.all([a ? tree(a) : [], b ? tree(b) : []]);
	const was = new Map(before.map((e) => [e.name, e]));
	const now = new Map(after.map((e) => [e.name, e]));
	const out: string[] = [];
	for (const name of new Set([...was.keys(), ...now.keys()])) {
		const x = was.get(name);
		const y = now.get(name);
		if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
		const path = `${prefix}${name}`;
		const xTree = x?.type === "tree";
		const yTree = y?.type === "tree";
		if (xTree || yTree)
			out.push(...(await changedFiles(tree, xTree ? x!.hash : null, yTree ? y!.hash : null, `${path}/`)));
		if ((x && !xTree) || (y && !yTree)) out.push(path);
	}
	return out;
}
