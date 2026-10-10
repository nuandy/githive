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
	const chain = await firstParentChain(source, baseline, branch);
	const known = kept && chain.length ? await keptFiles(kept, chain) : {};
	// A commit's first parent is the previous commit in the chain, or the baseline for the first one.
	const trees = new Map(chain.map((commit) => [commit.hash, commit.treeHash]));
	const missing = chain.filter((commit) => !known[commit.hash]);
	const first = missing.find((commit) => commit.parents[0] && !trees.has(commit.parents[0]));
	if (first?.parents[0]) {
		const parent = await source.readCommit(first.parents[0]);
		if (parent) trees.set(parent.hash, parent.treeHash);
	}
	const tree = treeReader(source);
	const worked = await atMost(DIFFS_AT_ONCE, missing, async (commit) => {
		const before = commit.parents[0] ? trees.get(commit.parents[0]) : undefined;
		if (commit.parents[0] && !before)
			throw new Error(`${commit.hash}'s first parent ${commit.parents[0]} isn't on ${branch}'s history`);
		return [commit.hash, (await changedFiles(tree, before ?? null, commit.treeHash)).sort()] as const;
	});
	const files = { ...known, ...Object.fromEntries(worked) };
	if (kept && worked.length) await kept.put(Object.fromEntries(worked)).catch(() => undefined);
	return chain.map((commit) => ({
		commit: commit.hash,
		parents: commit.parents,
		author: commit.author.name,
		message: commit.message.replace(/\n+$/, ""),
		files: files[commit.hash] ?? [],
	}));
}

// `branch`'s first-parent commits after `baseline`, oldest first.
async function firstParentChain(source: HistorySource, baseline: string, branch: string): Promise<CommitMeta[]> {
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
	return chain.reverse();
}

const keptFiles = (kept: KeptFiles, chain: CommitMeta[]) =>
	kept.get(chain.map((commit) => commit.hash)).catch(() => ({}) as Record<string, string[]>);

// Reads each tree at most once.
function treeReader(source: HistorySource) {
	const read = new Map<string, Promise<TreeEntry[]>>();
	return (hash: string) => {
		if (!read.has(hash))
			read.set(
				hash,
				source.readTree(hash).then((entries) => entries ?? []),
			);
		return read.get(hash)!;
	};
}

/** The sorted paths that differ between trees `a` and `b`, where null is an empty tree. */
export async function filesBetween(source: HistorySource, a: string | null, b: string | null): Promise<string[]> {
	return (await changedFiles(treeReader(source), a, b)).sort();
}

// Reads only the folders whose hashes differ. Matches `git diff-tree -r --name-only`: a mode change counts, and a
// folder replaced by a file lists both.
async function changedFiles(
	tree: (hash: string) => Promise<TreeEntry[]>,
	beforeTree: string | null,
	afterTree: string | null,
	prefix = "",
): Promise<string[]> {
	if (beforeTree === afterTree) return [];
	const [beforeEntries, afterEntries] = await Promise.all([
		beforeTree ? tree(beforeTree) : [],
		afterTree ? tree(afterTree) : [],
	]);
	const before = new Map(beforeEntries.map((entry) => [entry.name, entry]));
	const after = new Map(afterEntries.map((entry) => [entry.name, entry]));
	const changed: string[] = [];
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		const was = before.get(name);
		const now = after.get(name);
		if (was && now && was.hash === now.hash && was.mode === now.mode) continue;
		const path = `${prefix}${name}`;
		const wasFolder = was?.type === "tree";
		const nowFolder = now?.type === "tree";
		if (wasFolder || nowFolder) {
			const inside = await changedFiles(tree, wasFolder ? was!.hash : null, nowFolder ? now!.hash : null, `${path}/`);
			changed.push(...inside);
		}
		if ((was && !wasFolder) || (now && !nowFolder)) changed.push(path);
	}
	return changed;
}
