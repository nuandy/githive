import git from "isomorphic-git";
import { http } from "../git-http";
import { isEmptyRepo, type Remote, Workspace } from "../git";
import { fetchCommits } from "../git-fetch";
import { formatOf, RECORD_FORMAT, upgradeState } from "../record-format";
import { retryTransient } from "../retry";
import type { MergeRecord } from "./audit";
import type { Registry } from "./claims";
import { decodeShard, shardsPrefix } from "./shards";

// Reading the records back out of Git for the audit: the full
// history of a record ref (claims, votes), and main's commits since GitHive
// started, with their trailers and the files each changed.

const DIR = "/records";
const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });
const decoder = new TextDecoder();

/** Every state a record ref has had, oldest first, with the commit that set it. */
export async function readRecordHistory<S>(remote: Remote, ref: string): Promise<{ tip: string; state: S }[]> {
	const refs = await git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: ref, onAuth: onAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	const tip = refs.find((r) => r.ref === ref)?.oid;
	if (!tip) return [];
	const { fs } = await retryTransient(() => fetchCommits(remote, [tip], DIR, { history: true }));
	// One cache for every read: without it, each read loads the packfile again, and a history read all at once held
	// hundreds of copies (a 202-state registry, 6 MB of JSON, took 572 MB: far past a Worker's 128).
	const cache = {};
	const history = (await git.log({ fs, dir: DIR, ref: tip, cache })).reverse();
	return Promise.all(
		history.map(async (entry) => ({
			tip: entry.oid,
			state: stateOf<S>(entry.commit.message, decoder.decode((await git.readBlob({ fs, dir: DIR, oid: entry.oid, filepath: "state.json", cache })).blob), ref),
		})),
	);
}

/** A record commit's state, upgraded from the format it was written in; a newer format's as it is. */
function stateOf<S>(message: string, text: string, ref: string): S {
	const format = formatOf(message);
	const raw = JSON.parse(text);
	return format > RECORD_FORMAT ? (raw as S) : upgradeState<S>(raw, format, ref);
}

/**
 * Every claims shard's history (see shards.ts), by shard, from every repo that
 * holds shards: per repo, one listing and one fetch of every shard's history.
 */
export async function readShardHistories(remotes: Remote[], repo: string) {
	const prefix = shardsPrefix(repo);
	return new Map([...(await readRefHistories<Registry>(remotes, prefix))].map(([name, history]) => [decodeShard(name), history]));
}

/** Every record ref's history under `prefix` (vote buckets, say), by the rest of its name: per repo, one listing and one fetch. */
export async function readRefHistories<S>(remotes: Remote[], prefix: string) {
	// A few repos at a time: a Worker request holds only 6 connections open, and 16 records repos read at once stalled
	// and were cancelled (the audit reads two kinds of records, shards and vote buckets, side by side).
	const perRepo = await inTurns(
		REPOS_AT_ONCE,
		remotes.map((remote) => async () => {
			const { refs, fs } = await listAndFetch(remote, prefix);
			// One cache for every read from this repo (see readRecordHistory).
			const cache = {};
			return Promise.all(
				refs.map(async (r) => {
					const history = (await git.log({ fs, dir: DIR, ref: r.oid, cache })).reverse();
					const states = await Promise.all(
						history.map(async (entry) => ({
							tip: entry.oid,
							state: stateOf<S>(entry.commit.message, decoder.decode((await git.readBlob({ fs, dir: DIR, oid: entry.oid, filepath: "state.json", cache })).blob), r.ref),
						})),
					);
					return [r.ref.slice(prefix.length), states] as const;
				}),
			);
		}),
	);
	return new Map(perRepo.flat());
}

/** How many records repos one read of histories fetches from at once. */
const REPOS_AT_ONCE = 2;

/** Run `tasks`, at most `n` at a time; their results in order. */
async function inTurns<R>(n: number, tasks: (() => Promise<R>)[]): Promise<R[]> {
	const results: R[] = new Array(tasks.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, tasks.length) }, async () => {
			while (next < tasks.length) {
				const i = next++;
				results[i] = await tasks[i]();
			}
		}),
	);
	return results;
}

/** The refs under `prefix`, and their histories in one fetch; listed again if one moves in between (its old tip is no longer served). */
async function listAndFetch(remote: Remote, prefix: string) {
	for (let attempt = 1; ; attempt++) {
		const refs = (await retryTransient(() => git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, onAuth: onAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))))).filter((r) => r.ref.startsWith(prefix));
		try {
			const { fs } = await retryTransient(() => fetchCommits(remote, [...new Set(refs.map((r) => r.oid))], DIR, { history: true }));
			return { refs, fs };
		} catch (err) {
			if (attempt < 3 && /not our ref|fetch refused/i.test(String(err))) continue;
			throw err;
		}
	}
}

const trailer = (message: string, name: string) => message.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim();

/** The project branch's commits after `baseline`, oldest first, following first parents: every one is audited. */
export async function readMainMerges(remote: Remote, baseline: string, branch: string): Promise<MergeRecord[]> {
	const ws = await Workspace.clone(remote, branch);
	const records: MergeRecord[] = [];
	for (let oid = await ws.head(); oid && oid !== baseline; ) {
		const { commit } = await ws.ensureCommit(oid);
		const [first] = commit.parent;
		records.push(mergeRecordOf({ commit: oid, parents: commit.parent, author: commit.author.name, message: commit.message, files: first ? await ws.changedPaths(first, oid) : [] }));
		oid = first;
	}
	return records.reverse();
}

/** A commit on a branch as git tells it: its parents, its author's name, its message, and the files it changed from its first parent. */
export interface BranchCommit {
	commit: string;
	parents: string[];
	author: string;
	message: string;
	files: string[];
}

/** A commit on a branch as the audit reads it: what its trailers say, and what it joins. */
export function mergeRecordOf(c: BranchCommit): MergeRecord {
	const [first, second] = c.parents;
	return {
		commit: c.commit,
		author: trailer(c.message, "GitHive-Agent") ?? c.author,
		change: trailer(c.message, "GitHive-Change"),
		claimsTip: trailer(c.message, "GitHive-Claims"),
		votesTip: trailer(c.message, "GitHive-Votes"),
		testedOn: trailer(c.message, "GitHive-Tested"),
		testedAfter: trailer(c.message, "GitHive-Tested-After")?.split(/\s+/).filter(Boolean),
		testedWith: trailer(c.message, "GitHive-Tested-With")?.split(/\s+/).filter(Boolean),
		by: trailer(c.message, "GitHive-By"),
		stamp: trailer(c.message, "GitHive-Stamp"),
		reverts: trailer(c.message, "GitHive-Reverts"),
		base: first,
		head: second,
		files: c.files,
	};
}
