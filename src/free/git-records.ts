import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { type Remote, Workspace } from "../git";
import { MemoryFS } from "../memory-fs";
import type { MergeRecord } from "./audit";

// Reading the coordinator-free records back out of Git for the audit: the full
// history of a record ref (claims, votes), and main's commits since the mode
// started, with their trailers and the files each changed.

const DIR = "/records";
const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });
const decoder = new TextDecoder();

/** Every state a record ref has had, oldest first, with the commit that set it. */
export async function readRecordHistory<S>(remote: Remote, ref: string): Promise<{ tip: string; state: S }[]> {
	const refs = await git.listServerRefs({ http, url: remote.url, prefix: ref, onAuth: onAuth(remote) });
	if (!refs.some((r) => r.ref === ref)) return [];
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote.url });
	await git.setConfig({ fs, dir: DIR, path: "remote.origin.fetch", value: "+refs/notes/*:refs/remotes/origin/notes/*" });
	const { fetchHead } = await git.fetch({ fs, http, dir: DIR, remote: "origin", ref, remoteRef: ref, singleBranch: true, tags: false, onAuth: onAuth(remote) });
	if (!fetchHead) return [];
	await git.writeRef({ fs, dir: DIR, ref: "refs/record", value: fetchHead, force: true });
	const history = (await git.log({ fs, dir: DIR, ref: "refs/record" })).reverse();
	return Promise.all(
		history.map(async (entry) => ({
			tip: entry.oid,
			state: JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: entry.oid, filepath: "state.json" })).blob)) as S,
		})),
	);
}

const trailer = (message: string, name: string) => message.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim();

/** Main's commits after `baseline`, oldest first, following first parents: every one is audited. */
export async function readMainMerges(remote: Remote, baseline: string): Promise<MergeRecord[]> {
	const ws = await Workspace.clone(remote);
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
			base: first,
			head: second,
			files: first ? await ws.changedPaths(first, oid) : [],
		});
		oid = first;
	}
	return records.reverse();
}
