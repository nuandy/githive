import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { isEmptyRepo, type Remote, Workspace } from "../git";
import { fetchCommits } from "../git-fetch";
import { retryTransient } from "../retry";
import type { MergeRecord } from "./audit";
import type { Registry } from "./claims";
import { decodeShard, shardsPrefix } from "./shards";

// Reading the coordinator-free records back out of Git for the audit: the full
// history of a record ref (claims, votes), and main's commits since the mode
// started, with their trailers and the files each changed.

const DIR = "/records";
const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });
const decoder = new TextDecoder();

/** Every state a record ref has had, oldest first, with the commit that set it. */
export async function readRecordHistory<S>(remote: Remote, ref: string): Promise<{ tip: string; state: S }[]> {
	const refs = await git.listServerRefs({ http, url: remote.url, prefix: ref, onAuth: onAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	const tip = refs.find((r) => r.ref === ref)?.oid;
	if (!tip) return [];
	const { fs } = await retryTransient(() => fetchCommits(remote, [tip], DIR, { history: true }));
	const history = (await git.log({ fs, dir: DIR, ref: tip })).reverse();
	return Promise.all(
		history.map(async (entry) => ({
			tip: entry.oid,
			state: JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: entry.oid, filepath: "state.json" })).blob)) as S,
		})),
	);
}

/** Every claims shard's history (see shards.ts), by shard, from every repo that holds shards. */
export async function readShardHistories(remotes: Remote[], repo: string) {
	const prefix = shardsPrefix(repo);
	const perRepo = await Promise.all(
		remotes.map(async (remote) => {
			const refs = await git.listServerRefs({ http, url: remote.url, prefix, onAuth: onAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
			return Promise.all(refs.filter((r) => r.ref.startsWith(prefix)).map(async (r) => [decodeShard(r.ref.slice(prefix.length)), await readRecordHistory<Registry>(remote, r.ref)] as const));
		}),
	);
	return new Map(perRepo.flat());
}

const trailer = (message: string, name: string) => message.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim();

/** The project branch's commits after `baseline`, oldest first, following first parents: every one is audited. */
export async function readMainMerges(remote: Remote, baseline: string, branch: string): Promise<MergeRecord[]> {
	const ws = await Workspace.clone(remote, branch);
	const records: MergeRecord[] = [];
	for (let oid = await ws.head(); oid && oid !== baseline; ) {
		const { commit } = await git.readCommit({ fs: ws.fs, dir: "/repo", oid });
		const [first, second] = commit.parent;
		records.push({
			commit: oid,
			author: trailer(commit.message, "Blueprint-Agent") ?? commit.author.name,
			change: trailer(commit.message, "Blueprint-Change"),
			claimsTip: trailer(commit.message, "Blueprint-Claims"),
			votesTip: trailer(commit.message, "Blueprint-Votes"),
			testedOn: trailer(commit.message, "Blueprint-Tested"),
			by: trailer(commit.message, "Blueprint-By"),
			stamp: trailer(commit.message, "Blueprint-Stamp"),
			reverts: trailer(commit.message, "Blueprint-Reverts"),
			base: first,
			head: second,
			files: first ? await ws.changedPaths(first, oid) : [],
		});
		oid = first;
	}
	return records.reverse();
}
