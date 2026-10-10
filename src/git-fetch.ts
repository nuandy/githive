import git from "isomorphic-git";
import type { Remote } from "./git";
import { gitFetch, noteGitRequest } from "./git-http";
import { MemoryFS } from "./memory-fs";

// isomorphic-git fetches one ref per request, so reading many record refs was slow.
// This speaks upload-pack directly to fetch several commits in one request.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FETCHED = "/fetched";

const pktLine = (line: string) => {
	const payload = encoder.encode(line);
	return [encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload];
};

const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/**
 * Fetch commits at ref tips, with their trees, into an in-memory repo in one request.
 * A server error carries its status so callers can retry.
 */
export async function fetchCommits(remote: Remote, oids: string[], dir = FETCHED, { history = false, depth = 1 } = {}) {
	const fs = new MemoryFS();
	await git.init({ fs, dir });
	if (!oids.length) return { fs, dir };
	const secret = remote.token.split("?expires=")[0];
	const response = await gitFetch(`${remote.url}/git-upload-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			Accept: "application/x-git-upload-pack-result",
			Authorization: `Basic ${btoa(`x:${secret}`)}`,
		},
		body: uploadPackRequest(oids, history, depth),
	});
	noteGitRequest(`${remote.url}/git-upload-pack`, response.status);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw Object.assign(new Error(`fetch failed: ${response.status} ${detail}`), { status: response.status });
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	// An empty 200 is a server failure (see git-http.ts), so callers retry it.
	if (!bytes.length)
		throw Object.assign(new Error(`fetch failed: an empty answer from ${remote.url}`), { status: 502 });
	const filepath = ".git/objects/pack/pack-fetched.pack";
	await fs.promises.writeFile(`${dir}/${filepath}`, packFrom(bytes));
	await git.indexPack({ fs, dir, filepath });
	return { fs, dir };
}

/** The upload-pack request body: a want line per commit, with the capabilities on the first. */
function uploadPackRequest(oids: string[], history: boolean, depth: number) {
	const shallow = history ? "" : " shallow";
	const capabilities = ` side-band-64k ofs-delta${shallow} no-progress agent=githive`;
	const wants = oids.flatMap((oid, index) => pktLine(`want ${oid}${index === 0 ? capabilities : ""}\n`));
	const deepen = history ? [] : pktLine(`deepen ${depth}\n`);
	return concat([...wants, ...deepen, encoder.encode("0000"), ...pktLine("done\n")]);
}

/** The pack in an upload-pack response, throwing the server's error if it sent one. */
function packFrom(bytes: Uint8Array) {
	// Shallow lines and NAK come first, then the pack in side-band packets (1 data, 2 progress, 3 error).
	const pack: Uint8Array[] = [];
	let inPack = false;
	for (let at = 0; at + 4 <= bytes.length;) {
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
	return concat(pack);
}
