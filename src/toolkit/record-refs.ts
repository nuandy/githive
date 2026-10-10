import git from "isomorphic-git";
import { gitAuth, http } from "../git-http";
import { isEmptyRepo, type Remote } from "../git";
import { fetchCommits } from "../git-fetch";
import { retryTransient } from "../retry";

// Reads many record refs (claims shards, vote buckets) at once, with one listing per repo and one fetch for
// every tip not read yet.

// Record states by commit. A commit never changes, so a state once read stays valid. Only finished reads are
// cached, so no request waits on another's I/O.
const states = new Map<string, unknown>();
const decoder = new TextDecoder();

/** Every record ref under `prefix` with the state at its tip. Brief server failures are retried. */
export async function readAllShards<S>(remote: Remote, prefix: string) {
	return readListed<S>(remote, async () => (await listRefs(remote, prefix)).filter((r) => r.ref.startsWith(prefix)));
}

/** The given refs that exist, with the state at each tip. */
export async function readRefs<S>(remote: Remote, refs: string[]) {
	const wanted = new Set(refs);
	return readListed<S>(remote, async () =>
		(await listRefs(remote, sharedPrefix(refs))).filter((r) => wanted.has(r.ref)),
	);
}

function sharedPrefix(refs: string[]) {
	let prefix = refs[0] ?? "";
	for (const ref of refs) while (!ref.startsWith(prefix)) prefix = prefix.slice(0, -1);
	return prefix;
}

const listRefs = (remote: Remote, prefix: string) =>
	retryTransient(() =>
		git
			.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, ...gitAuth(remote) })
			.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))),
	);

async function readListed<S>(
	remote: Remote,
	list: () => Promise<{ ref: string; oid: string }[]>,
): Promise<{ ref: string; tip: string; state: S }[]> {
	for (let attempt = 1; ; attempt++) {
		const listed = await list();
		const missing = [...new Set(listed.map((r) => r.oid).filter((oid) => !states.has(oid)))];
		try {
			if (missing.length) {
				const { fs, dir } = await retryTransient(() => fetchCommits(remote, missing));
				for (const oid of missing) {
					const { blob } = await git.readBlob({ fs, dir, oid, filepath: "state.json" });
					states.set(oid, JSON.parse(decoder.decode(blob)));
				}
			}
		} catch (err) {
			// A ref moved between the listing and the fetch, so its old tip is no longer served. List again.
			if (attempt < 3 && /not our ref|fetch refused/i.test(String(err))) continue;
			throw err;
		}
		return listed.map((r) => ({ ref: r.ref, tip: r.oid, state: states.get(r.oid) as S }));
	}
}
