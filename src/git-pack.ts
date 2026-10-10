import type { Remote } from "./git";
import { concat, packFrom, pktLine } from "./git-fetch";
import { gitFetch, noteGitRequest } from "./git-http";

// Moving Git objects between repos without a checkout: the pack a commit adds beyond what a repo already has,
// fetched from one repo, and pushes that update several refs in one request.

export const ZERO_OID = "0".repeat(40);

const decoder = new TextDecoder();

const basicAuth = (remote: Remote) => `Basic ${btoa(`x:${remote.token.split("?expires=")[0]}`)}`;

/** A ref update in a push: create it (`from` null), move it, or delete it (`to` null). */
export interface RefUpdate {
	ref: string;
	from: string | null;
	to: string | null;
}

/**
 * The objects reachable from `want` but not from `haves`, packed by the server, from one upload-pack request.
 * The pack is complete on its own (no thin pack), so a repo that has `haves` can take it as it is.
 */
export async function fetchPackSince(remote: Remote, want: string, haves: string[]): Promise<Uint8Array> {
	const parts = [
		...pktLine(`want ${want} side-band-64k no-progress agent=githive\n`),
		new TextEncoder().encode("0000"),
		...haves.flatMap((have) => pktLine(`have ${have}\n`)),
		...pktLine("done\n"),
	];
	const response = await gitFetch(`${remote.url}/git-upload-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			Accept: "application/x-git-upload-pack-result",
			Authorization: basicAuth(remote),
		},
		body: concat(parts),
	});
	noteGitRequest(`${remote.url}/git-upload-pack`, response.status);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw Object.assign(new Error(`fetch failed: ${response.status} ${detail}`), { status: response.status });
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!bytes.length)
		throw Object.assign(new Error(`fetch failed: an empty answer from ${remote.url}`), { status: 502 });
	return packFrom(bytes);
}

/** What a receive-pack request did: busy (applied nothing), or each ref's result, `true` or the server's reason. */
export type PushReport = { busy: true } | { unpack: string; refs: Map<string, true | string> };

/**
 * Sends `updates` and `pack` in one receive-pack request, skipping ref discovery. The server moves a ref only if
 * it's still at `from`. Throws on an HTTP failure, with its status.
 */
export async function receivePack(remote: Remote, updates: RefUpdate[], pack?: Uint8Array): Promise<PushReport> {
	const commands = updates.flatMap((update, index) => {
		const capabilities = index === 0 ? "\0report-status delete-refs agent=githive" : "";
		return pktLine(`${update.from ?? ZERO_OID} ${update.to ?? ZERO_OID} ${update.ref}${capabilities}\n`);
	});
	const onlyDeletes = updates.every((update) => update.to === null);
	const body = concat([...commands, new TextEncoder().encode("0000"), ...(onlyDeletes || !pack ? [] : [pack])]);
	const response = await gitFetch(`${remote.url}/git-receive-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-receive-pack-request",
			Accept: "application/x-git-receive-pack-result",
			Authorization: basicAuth(remote),
		},
		body,
	});
	noteGitRequest(`${remote.url}/git-receive-pack`, response.status);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw Object.assign(new Error(`push failed: ${response.status} ${detail}`), { status: response.status });
	}
	const lines = reportLines(new Uint8Array(await response.arrayBuffer()));
	if (lines.some((line) => line.startsWith("ERR") && /busy/i.test(line))) return { busy: true };
	const unpack = lines.find((line) => line.startsWith("unpack "))?.slice("unpack ".length) ?? "no report";
	const refs = new Map<string, true | string>();
	for (const line of lines) {
		if (line.startsWith("ok ")) refs.set(line.slice(3), true);
		else if (line.startsWith("ng ")) {
			const [ref = "", ...reason] = line.slice(3).split(" ");
			refs.set(ref, reason.join(" ") || "refused");
		}
	}
	return { unpack, refs };
}

function reportLines(body: Uint8Array) {
	const lines: string[] = [];
	for (let at = 0; at + 4 <= body.length;) {
		const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
		if (!length) {
			at += 4;
			continue;
		}
		lines.push(decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, ""));
		at += length;
	}
	return lines;
}
