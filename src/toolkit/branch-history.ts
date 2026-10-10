import type { BranchCommit } from "./git-records";
import { atMost } from "./merge";

// A branch's history as the audit reads it, through Artifacts' own API
// rather than a clone: its first-parent chain from log, and each commit's
// files changed from its first parent by comparing their trees, reading only
// the folders that differ. No Git client, no container: read in a Worker
// with a clone, 200 merges took 12 s and most of its memory, so it had moved
// into the repo's Gate container. A commit's files never change (its hash
// names them), so each is worked out once and kept (see KeptFiles): an audit
// after reads trees only for merges new since.

/** A commit as Artifacts' API decodes it. */
export interface CommitMeta {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string };
	parents: string[];
}

/** An entry of a tree as Artifacts' API reads it. */
export interface TreeEntry {
	name: string;
	mode: string;
	hash: string;
	type: string;
}

/** What the audit reads of a repo: Artifacts' log, readCommit and readTree. */
export interface HistorySource {
	/** The first-parent chain from `ref`, newest first: `limit` commits after the first `offset`. */
	log(ref: string, limit: number, offset: number): Promise<CommitMeta[]>;
	readCommit(hash: string): Promise<CommitMeta | null>;
	readTree(hash: string): Promise<TreeEntry[] | null>;
}

/** Commits' files changed from their first parent, kept by commit: once worked out, they're the same for good. */
export interface KeptFiles {
	get(commits: string[]): Promise<Record<string, string[]>>;
	put(files: Record<string, string[]>): Promise<void>;
}

/** How many commits one log call lists (Artifacts' most). */
const LOG_PAGE = 1000;
/** How many commits' trees are compared at once. */
const DIFFS_AT_ONCE = 6;

/**
 * `branch`'s commits after `baseline`, oldest first, following first parents:
 * each one's parents, author, message and the files it changed from its first
 * parent (sorted). What the audit replays, as `git log --first-parent
 * baseline..branch` with `git diff-tree -r --name-only` would tell it.
 */
export async function readBranchHistory(source: HistorySource, baseline: string, branch: string, kept?: KeptFiles): Promise<BranchCommit[]> {
	const chain: CommitMeta[] = [];
	let reached = false;
	// Page after page until the baseline, or an empty page (the root): a page shorter than asked for isn't taken for the
	// end, so a page cut short (a smaller cap, say) can't silently drop history from the audit.
	for (let offset = 0; !reached; ) {
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
	const known = kept && chain.length ? await kept.get(chain.map((c) => c.hash)).catch(() => ({}) as Record<string, string[]>) : {};
	// Each commit's first parent's tree: the commit before it in the chain, or the baseline's for the first.
	const trees = new Map(chain.map((c) => [c.hash, c.treeHash]));
	const missing = chain.filter((c) => !known[c.hash]);
	const first = missing.find((c) => c.parents[0] && !trees.has(c.parents[0]));
	if (first?.parents[0]) {
		const parent = await source.readCommit(first.parents[0]);
		if (parent) trees.set(parent.hash, parent.treeHash);
	}
	const read = new Map<string, Promise<TreeEntry[]>>();
	const tree = (hash: string) => {
		if (!read.has(hash)) read.set(hash, source.readTree(hash).then((entries) => entries ?? []));
		return read.get(hash)!;
	};
	const worked = await atMost(DIFFS_AT_ONCE, missing, async (c) => {
		const before = c.parents[0] ? trees.get(c.parents[0]) : undefined;
		if (c.parents[0] && !before) throw new Error(`${c.hash}'s first parent ${c.parents[0]} isn't on ${branch}'s history`);
		return [c.hash, (await changedFiles(tree, before ?? null, c.treeHash)).sort()] as const;
	});
	const files = { ...known, ...Object.fromEntries(worked) };
	if (kept && worked.length) await kept.put(Object.fromEntries(worked)).catch(() => undefined);
	return chain.map((c) => ({ commit: c.hash, parents: c.parents, author: c.author.name, message: c.message.replace(/\n+$/, ""), files: files[c.hash] ?? [] }));
}

/** The paths that differ between trees `a` and `b` (null: none), sorted, read through `source` (see changedFiles). */
export async function filesBetween(source: HistorySource, a: string | null, b: string | null): Promise<string[]> {
	const read = new Map<string, Promise<TreeEntry[]>>();
	const tree = (hash: string) => {
		if (!read.has(hash)) read.set(hash, source.readTree(hash).then((entries) => entries ?? []));
		return read.get(hash)!;
	};
	return (await changedFiles(tree, a, b)).sort();
}

/**
 * The paths that differ between trees `a` and `b` (null: none), reading only
 * the folders whose hashes differ: what `git diff-tree -r --name-only` lists
 * (a mode change counts; a folder replaced by a file lists both).
 */
async function changedFiles(tree: (hash: string) => Promise<TreeEntry[]>, a: string | null, b: string | null, prefix = ""): Promise<string[]> {
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
		if (xTree || yTree) out.push(...(await changedFiles(tree, xTree ? x!.hash : null, yTree ? y!.hash : null, `${path}/`)));
		if ((x && !xTree) || (y && !yTree)) out.push(path);
	}
	return out;
}
