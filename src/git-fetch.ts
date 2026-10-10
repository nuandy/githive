import git from "isomorphic-git";
import type { Remote } from "./git";
import { gitFetch, noteGitRequest } from "./git-http";
import { MemoryFS } from "./memory-fs";

// Fetching several commits in one request. isomorphic-git fetches one ref at a
// time (and, fetching everything, only branches), so reading many record refs
// (claims shards) cost a request each. This speaks Git's upload-pack directly:
// one request wanting every commit, each without its history.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FETCHED = "/fetched";

const pktLine = (line: string) => {
	const payload = encoder.encode(line);
	return [encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload];
};

const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/**
 * Fetch `oids` (commits the server has at ref tips) with their trees and
 * blobs, without history, in one upload-pack request. Returns an in-memory
 * repo holding them. A server error carries its status, for retries.
 */
export async function fetchCommits(remote: Remote, oids: string[], dir = FETCHED, { history = false, depth = 1 } = {}) {
	const fs = new MemoryFS();
	await git.init({ fs, dir });
	if (!oids.length) return { fs, dir };
	const body = concat([
		...oids.flatMap((oid, i) => pktLine(`want ${oid}${i === 0 ? ` side-band-64k ofs-delta${history ? "" : " shallow"} no-progress agent=githive` : ""}\n`)),
		// Just the commits (or `depth` commits of each), or (history) everything behind them too.
		...(history ? [] : pktLine(`deepen ${depth}\n`)),
		encoder.encode("0000"),
		...pktLine("done\n"),
	]);
	const response = await gitFetch(`${remote.url}/git-upload-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			Accept: "application/x-git-upload-pack-result",
			Authorization: `Basic ${btoa(`x:${remote.token.split("?expires=")[0]}`)}`,
		},
		body,
	});
	noteGitRequest(`${remote.url}/git-upload-pack`, response.status);
	if (!response.ok) throw Object.assign(new Error(`fetch failed: ${response.status} ${(await response.text()).slice(0, 200)}`), { status: response.status });
	const bytes = new Uint8Array(await response.arrayBuffer());
	// Empty though it says 200 (see git-http.ts): a server failure, for the caller to try again.
	if (!bytes.length) throw Object.assign(new Error(`fetch failed: an empty answer from ${remote.url}`), { status: 502 });

	// Shallow lines and NAK, then the pack in side-band packets (1: data, 2: progress, 3: error).
	const pack: Uint8Array[] = [];
	let inPack = false;
	for (let at = 0; at + 4 <= bytes.length; ) {
		const length = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
		if (!length) {
			at += 4;
			continue;
		}
		const payload = bytes.subarray(at + 4, at + length);
		at += length;
		if (!inPack && payload[0] > 3) {
			const line = decoder.decode(payload);
			if (line.startsWith("ERR")) throw new Error(`fetch refused: ${line.trim()}`);
			if (line.startsWith("NAK") || line.startsWith("ACK")) inPack = true;
			continue;
		}
		inPack = true;
		if (payload[0] === 1) pack.push(payload.subarray(1));
		else if (payload[0] === 3) throw new Error(`fetch failed: ${decoder.decode(payload.subarray(1)).trim()}`);
	}
	const filepath = ".git/objects/pack/pack-fetched.pack";
	await fs.promises.writeFile(`${dir}/${filepath}`, concat(pack));
	await git.indexPack({ fs, dir, filepath });
	return { fs, dir };
}
