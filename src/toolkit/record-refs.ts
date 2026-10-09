import git from "isomorphic-git";
import { gitAuth, http } from "../git-http";
import { isEmptyRepo, type Remote } from "../git";
import { fetchCommits } from "../git-fetch";
import { retryTransient } from "../retry";

// Reading many record refs (claims shards, vote buckets) at once: one listing
// per repo, then one fetch for every tip whose state isn't known yet.

/**
 * Record states by commit, for the isolate. A commit never changes, so a state
 * once read stays right; only states already read are kept (no request waits
 * on another's I/O).
 */
const states = new Map<string, unknown>();
const decoder = new TextDecoder();

/**
 * Every record ref under `prefix`, at its tip: one listing, then one fetch for
 * all the refs whose tips aren't known yet. Brief server failures are retried.
 */
export async function readAllShards<S>(remote: Remote, prefix: string) {
	return readListed<S>(remote, async () => (await listRefs(remote, prefix)).filter((r) => r.ref.startsWith(prefix)));
}

/** These refs (where they exist) at their tips: one listing (of the prefix they share), then one fetch for the commits not known yet. */
export async function readRefs<S>(remote: Remote, refs: string[]) {
	const wanted = new Set(refs);
	return readListed<S>(remote, async () => (await listRefs(remote, sharedPrefix(refs))).filter((r) => wanted.has(r.ref)));
}

/** The longest prefix every ref starts with. */
function sharedPrefix(refs: string[]) {
	let prefix = refs[0] ?? "";
	for (const ref of refs) while (!ref.startsWith(prefix)) prefix = prefix.slice(0, -1);
	return prefix;
}

const listRefs = (remote: Remote, prefix: string) =>
	retryTransient(() => git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, ...gitAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))));

/** Refs as `list` finds them, with their states: commits not known yet are fetched in one request. */
async function readListed<S>(remote: Remote, list: () => Promise<{ ref: string; oid: string }[]>): Promise<{ ref: string; tip: string; state: S }[]> {
	for (let attempt = 1; ; attempt++) {
		const listed = await list();
		const missing = [...new Set(listed.map((r) => r.oid).filter((oid) => !states.has(oid)))];
		try {
			if (missing.length) {
				const { fs, dir } = await retryTransient(() => fetchCommits(remote, missing));
				for (const oid of missing) states.set(oid, JSON.parse(decoder.decode((await git.readBlob({ fs, dir, oid, filepath: "state.json" })).blob)));
			}
		} catch (err) {
			// A ref moved between the listing and the fetch: its old tip is no longer served. List again.
			if (attempt < 3 && /not our ref|fetch refused/i.test(String(err))) continue;
			throw err;
		}
		return listed.map((r) => ({ ref: r.ref, tip: r.oid, state: states.get(r.oid) as S }));
	}
}
