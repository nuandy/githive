import git from "isomorphic-git";
import { inLane } from "./claim-paths";
import type { MemoryFS } from "./memory-fs";
import { type DiffHunk, unifiedDiff } from "./unified-diff";

// A change's files as the change page's Files tab shows them: each file it changed between two commits, with its
// lines added and removed. The work is capped: the first DIFF_FILES files, DIFF_BYTES of them as JSON in all, and no
// side of a file over DIFF_FILE_BYTES is diffed. A binary file, or one too big, is marked rather than diffed; a file
// past the size cap keeps its counts and loses its lines.

/** The most files a diff lists; `total` counts the rest. */
export const DIFF_FILES = 300;
/**
 * The most a diff's files weigh as JSON, about 900 KB: escaped as they're sent, so the view holding them stays under
 * the most a kept view may weigh (see kept-view.ts) and the next reader doesn't diff them again.
 */
export const DIFF_BYTES = 900_000;
/** The most a side of a file may weigh to be diffed. */
export const DIFF_FILE_BYTES = 256 * 1024;

export interface FileDiff {
	path: string;
	status: "added" | "removed" | "modified";
	/** Lines added and removed, unless it's binary or too big to diff. */
	added?: number;
	removed?: number;
	/** Outside the change's claim. */
	outside?: true;
	binary?: true;
	tooBig?: true;
	/** Diffed, but its lines were left out: the diff's text ran out before it. */
	cut?: true;
	hunks?: DiffHunk[];
}

/** What changed between two commits, file by file, sorted by path. */
export interface CommitsDiff {
	base: string;
	head: string;
	files: FileDiff[];
	/** How many files changed in all: more than `files` lists when there were too many. */
	total: number;
}

/** A file's bytes on a side, or null where it doesn't exist. */
export type ReadSide = (side: "base" | "head", path: string) => Promise<Uint8Array | null>;

export interface DiffLimits {
	files?: number;
	bytes?: number;
	fileBytes?: number;
}

const decoder = new TextDecoder();

/** Like git, a NUL byte in the first 8 KB makes a file binary. */
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);

/**
 * Each of `paths` diffed between its two sides, flagged when it's outside `claimed` (none flagged without a claim),
 * within `limits`.
 */
export async function diffFiles(
	paths: string[],
	read: ReadSide,
	{ claimed, limits = {} }: { claimed?: string[] | null; limits?: DiffLimits } = {},
): Promise<{ files: FileDiff[]; total: number }> {
	const { files: mostFiles = DIFF_FILES, bytes: mostBytes = DIFF_BYTES, fileBytes = DIFF_FILE_BYTES } = limits;
	const sorted = [...new Set(paths)].sort();
	let left = mostBytes;
	const files: FileDiff[] = [];
	for (const path of sorted.slice(0, mostFiles)) {
		const [before, after] = [await read("base", path), await read("head", path)];
		if (!before && !after) continue;
		const file: FileDiff = { path, status: !before ? "added" : !after ? "removed" : "modified" };
		if (claimed && !inLane(path, claimed)) file.outside = true;
		const sides = [before, after].filter((bytes): bytes is Uint8Array => !!bytes);
		if (sides.some((bytes) => bytes.length > fileBytes)) file.tooBig = true;
		else if (sides.some(isBinary)) file.binary = true;
		else {
			const { hunks, added, removed } = unifiedDiff(
				decoder.decode(before ?? new Uint8Array()),
				decoder.decode(after ?? new Uint8Array()),
			);
			Object.assign(file, { added, removed });
			if (weight({ ...file, hunks }) <= left) file.hunks = hunks;
			else file.cut = true;
		}
		// Past the size cap even without its lines: it isn't listed, and `total` counts it.
		const size = weight(file);
		if (size > left) break;
		left -= size;
		files.push(file);
	}
	return { files, total: sorted.length };
}

/** A file's weight in a diff's JSON, with the comma after it. */
const weight = (file: FileDiff) => JSON.stringify(file).length + 1;

/** A repo held in memory, as isomorphic-git reads it. */
export interface HeldRepo {
	fs: MemoryFS;
	dir: string;
	cache?: object;
}

/** Each file that differs between commits `base` and `head`, diffed (see diffFiles). Both must be held. */
export async function diffCommits(
	repo: HeldRepo,
	base: string,
	head: string,
	options: { claimed?: string[] | null; limits?: DiffLimits } = {},
): Promise<CommitsDiff> {
	const paths = await changedFiles(repo, base, head);
	const read: ReadSide = (side, path) => blobAt(repo, side === "base" ? base : head, path);
	return { base, head, ...(await diffFiles(paths, read, options)) };
}

// The file paths whose content differs between two commits: a file that became a folder is listed, and so is
// each file in the folder.
async function changedFiles({ fs, dir, cache = {} }: HeldRepo, base: string, head: string) {
	const changed: string[] = [];
	await git.walk({
		fs,
		dir,
		cache,
		trees: [git.TREE({ ref: base }), git.TREE({ ref: head })],
		map: async (path, [before, after]) => {
			if (path === ".") return true;
			const [was, now] = [await before?.type(), await after?.type()];
			const [wasOid, nowOid] = [await before?.oid(), await after?.oid()];
			if (was === "tree" && now === "tree") return wasOid === nowOid ? null : true;
			if ((was === "blob" || now === "blob") && wasOid !== nowOid) changed.push(path);
			return was === "tree" || now === "tree" ? true : null;
		},
	});
	return changed;
}

// A file's bytes at a commit, or null where it isn't a file.
async function blobAt({ fs, dir, cache = {} }: HeldRepo, commit: string, filepath: string) {
	try {
		return (await git.readBlob({ fs, dir, oid: commit, filepath, cache })).blob;
	} catch (err) {
		if (err instanceof git.Errors.NotFoundError || err instanceof git.Errors.ObjectTypeError) return null;
		throw err;
	}
}
