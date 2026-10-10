import git from "isomorphic-git";
import { branchHead, type Remote } from "./git";
import { fetchCommits } from "./git-fetch";
import { fail } from "./errors";

// Browsing a repo's code for the dashboard: its files at a branch or commit,
// and one file's text. One commit is fetched alone (no history), and the last
// few are kept, so moving between files of the same commit costs nothing.

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const KEPT = 6;

type Snapshot = Awaited<ReturnType<typeof fetchCommits>> & { commit: string };
const kept = new Map<string, Promise<Snapshot>>();

/** The commit `ref` names: a commit id as given, else a branch's head. */
async function resolve(remote: Remote, ref: string) {
	if (/^[0-9a-f]{40}$/.test(ref)) return ref;
	return (await branchHead(remote, ref)) ?? fail(404, `no branch ${ref}`);
}

async function snapshot(remote: Remote, ref: string): Promise<Snapshot> {
	const commit = await resolve(remote, ref);
	const key = `${remote.url}@${commit}`;
	let found = kept.get(key);
	if (!found) {
		found = fetchCommits(remote, [commit]).then((repo) => ({ ...repo, commit }));
		found.catch(() => kept.delete(key));
		kept.set(key, found);
		if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
	}
	return found;
}

/** Every file at `ref`, sorted (the first MAX_FILES of a bigger tree). */
export async function listTree(remote: Remote, ref: string) {
	const { fs, dir, commit } = await snapshot(remote, ref);
	const files = (await git.listFiles({ fs, dir, ref: commit })).sort();
	return { commit, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/** One file's text at `ref`, or that it's binary or too big to show. */
export async function readFile(remote: Remote, ref: string, path: string) {
	if (!path || path.startsWith("/") || path.split("/").includes("..")) fail(400, "path must be a file in the repo");
	const { fs, dir, commit } = await snapshot(remote, ref);
	const { blob } = await git
		.readBlob({ fs, dir, oid: commit, filepath: path })
		.catch(() => fail(404, `no file ${path} at ${commit.slice(0, 8)}`));
	const base = { commit, path, size: blob.length };
	if (blob.length > MAX_FILE_BYTES) return { ...base, tooBig: true as const };
	// NUL bytes in the first 8 KB: binary, as Git decides.
	if (blob.subarray(0, 8192).includes(0)) return { ...base, binary: true as const };
	return { ...base, text: new TextDecoder().decode(blob) };
}
