import git from "isomorphic-git";
import { gitAuth, http } from "../git-http";
import { isEmptyRepo, type Remote, Workspace } from "../git";
import { fetchCommits } from "../git-fetch";
import { formatOf, RECORD_FORMAT, upgradeState } from "../record-format";
import { checkedState } from "../record-schemas";
import { retryTransient, whileRefsMove } from "../retry";
import type { MergeRecord } from "./audit";
import type { Registry } from "./claims";
import { decodeShard, shardsPrefix } from "./shards";

// Reads the records back out of Git for the audit: the full history of a record ref, and main's commits since GitHive
// started, with their trailers and the files each changed.

const DIR = "/records";
const decoder = new TextDecoder();

/** Every state a record ref has had, oldest first, with the commit that set it. */
export async function readRecordHistory<S>(remote: Remote, ref: string): Promise<{ tip: string; state: S }[]> {
	const refs = await git
		.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: ref, ...gitAuth(remote) })
		.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	const tip = refs.find((r) => r.ref === ref)?.oid;
	if (!tip) return [];
	const { fs } = await retryTransient(() => fetchCommits(remote, [tip], DIR, { history: true }));
	// One cache for every read. Without it, each read loads the packfile again, and a long history read at once holds
	// hundreds of copies, far more than a Worker's memory.
	return statesFrom<S>(fs, tip, ref, {});
}

type Fetched = Awaited<ReturnType<typeof fetchCommits>>["fs"];

// Every state the record `ref` had up to `tip`, oldest first. `cache` is shared by every read from one fetch.
async function statesFrom<S>(fs: Fetched, tip: string, ref: string, cache: object) {
	const history = (await git.log({ fs, dir: DIR, ref: tip, cache })).reverse();
	return Promise.all(
		history.map(async (entry) => {
			const { blob } = await git.readBlob({ fs, dir: DIR, oid: entry.oid, filepath: "state.json", cache });
			return { tip: entry.oid, state: stateOf<S>(entry.commit.message, decoder.decode(blob), ref) };
		}),
	);
}

/** A record commit's state, upgraded from the format it was written in; a newer format's as it is. */
function stateOf<S>(message: string, text: string, ref: string): S {
	const format = formatOf(message);
	const raw = JSON.parse(text);
	if (format > RECORD_FORMAT) return raw as S;
	return checkedState<S>(ref, upgradeState<S>(raw, format, ref));
}

/** Every claims shard's history by shard (see shards.ts), with one listing and one fetch per repo. */
export async function readShardHistories(remotes: Remote[], repo: string) {
	const prefix = shardsPrefix(repo);
	return new Map(
		[...(await readRefHistories<Registry>(remotes, prefix))].map(([name, history]) => [decodeShard(name), history]),
	);
}

/** Every record ref's history under `prefix`, by the rest of its name, with one listing and one fetch per repo. */
export async function readRefHistories<S>(remotes: Remote[], prefix: string) {
	// A few repos at a time, because a Worker request holds only 6 connections open and the audit reads shards and
	// vote buckets side by side. Reading every records repo at once stalls.
	const perRepo = await inTurns(
		REPOS_AT_ONCE,
		remotes.map((remote) => async () => {
			const { refs, fs } = await listAndFetch(remote, prefix);
			// One cache for every read from this repo (see readRecordHistory).
			const cache = {};
			return Promise.all(
				refs.map(async (listed) => {
					const states = await statesFrom<S>(fs, listed.oid, listed.ref, cache);
					return [listed.ref.slice(prefix.length), states] as const;
				}),
			);
		}),
	);
	return new Map(perRepo.flat());
}

// How many records repos one read of histories fetches from at once.
const REPOS_AT_ONCE = 2;

// Runs `tasks` at most `limit` at a time, returning their results in order.
async function inTurns<R>(limit: number, tasks: (() => Promise<R>)[]): Promise<R[]> {
	const results: R[] = new Array(tasks.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, tasks.length) }, async () => {
			while (next < tasks.length) {
				const index = next++;
				const task = tasks[index];
				if (task) results[index] = await task();
			}
		}),
	);
	return results;
}

// The refs under `prefix` and their histories in one fetch. If a ref moves in between, its old tip is no longer
// served, so the refs are listed again.
function listAndFetch(remote: Remote, prefix: string) {
	return whileRefsMove(async () => {
		const listed = await retryTransient(() =>
			git
				.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, ...gitAuth(remote) })
				.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))),
		);
		const refs = listed.filter((r) => r.ref.startsWith(prefix));
		const tips = [...new Set(refs.map((r) => r.oid))];
		const { fs } = await retryTransient(() => fetchCommits(remote, tips, DIR, { history: true }));
		return { refs, fs };
	});
}

/** A trailer's value, read from the message's last paragraph only, so text written by agents can't pose as one. */
export function trailer(message: string, name: string) {
	const block =
		message
			.trimEnd()
			.split(/\n[ \t]*\n/)
			.at(-1) ?? "";
	return block.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim();
}

/** The branch's first-parent commits after `baseline`, oldest first. Every one is audited. */
export async function readMainMerges(remote: Remote, baseline: string, branch: string): Promise<MergeRecord[]> {
	const workspace = await Workspace.clone(remote, branch);
	const records: MergeRecord[] = [];
	for (let oid: string | undefined = await workspace.head(); oid && oid !== baseline;) {
		const { commit } = await workspace.ensureCommit(oid);
		const [first] = commit.parent;
		records.push(
			mergeRecordOf({
				commit: oid,
				parents: commit.parent,
				author: commit.author.name,
				message: commit.message,
				files: first ? await workspace.changedPaths(first, oid) : [],
			}),
		);
		oid = first;
	}
	return records.reverse();
}

/** A commit on a branch, with the files it changed from its first parent. */
export interface BranchCommit {
	commit: string;
	parents: string[];
	author: string;
	message: string;
	files: string[];
}

/** A commit on a branch as the audit reads it: what its trailers say and which commits it joins. */
export function mergeRecordOf(branchCommit: BranchCommit): MergeRecord {
	const [first, second] = branchCommit.parents;
	const trailerOf = (name: string) => trailer(branchCommit.message, name);
	const commitsIn = (name: string) => trailerOf(name)?.split(/\s+/).filter(Boolean);
	return {
		commit: branchCommit.commit,
		author: trailerOf("GitHive-Agent") ?? branchCommit.author,
		change: trailerOf("GitHive-Change"),
		claimsTip: trailerOf("GitHive-Claims"),
		votesTip: trailerOf("GitHive-Votes"),
		testedOn: trailerOf("GitHive-Tested"),
		testedAfter: commitsIn("GitHive-Tested-After"),
		testedWith: commitsIn("GitHive-Tested-With"),
		by: trailerOf("GitHive-By"),
		stamp: trailerOf("GitHive-Stamp"),
		reverts: trailerOf("GitHive-Reverts"),
		base: first,
		head: second,
		files: branchCommit.files,
	};
}
