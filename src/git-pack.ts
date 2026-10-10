import { createHash } from "node:crypto";
import type { Remote } from "./git";
import { concat, pktLine } from "./git-fetch";
import { gitFetch, noteGitRequest } from "./git-http";

// Moving Git objects between repos without a checkout: the pack of objects some commits add beyond what a repo
// already has, fetched from one repo, and pushes that send several such packs as one. Packs stay in the chunks
// they arrived in and are sent on as views of them, so a landing holds each byte about once.

export const ZERO_OID = "0".repeat(40);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const basicAuth = (remote: Remote) => `Basic ${btoa(`x:${remote.token.split("?expires=")[0]}`)}`;

/** A ref update in a push: create it (`from` null), move it, or delete it (`to` null). */
export interface RefUpdate {
	ref: string;
	from: string | null;
	to: string | null;
}

/** How many more bytes a landing's fetches may read, shared by them. */
export interface FetchBudget {
	bytes: number;
}

/** Bytes as they arrived, in chunks, read in place rather than joined into one buffer. */
export class Chunks {
	readonly length: number;

	constructor(readonly parts: Uint8Array[]) {
		this.length = parts.reduce((total, part) => total + part.length, 0);
	}

	/** Views of the bytes from `start` to `end`, copying nothing. */
	slice(start: number, end = this.length): Uint8Array[] {
		const views: Uint8Array[] = [];
		let at = 0;
		for (const part of this.parts) {
			const from = Math.max(start - at, 0);
			const to = Math.min(end - at, part.length);
			if (from < to) views.push(part.subarray(from, to));
			at += part.length;
			if (at >= end) break;
		}
		return views;
	}

	/** The bytes from `start` to `end` in one array: a copy, for a few bytes at a time. */
	bytes(start: number, end: number) {
		return concat(this.slice(start, end));
	}
}

/**
 * The objects reachable from `wants` but not from `haves`, packed by the server, from one upload-pack request.
 * It asks for no thin pack and no offset deltas, so each object is whole or a delta against another object by id:
 * the pack stands on its own in any repo that has `haves`, and can be joined with others byte for byte. Without
 * side-band the pack arrives as it is. Returns "too big" as soon as the fetches have read more than `budget` allows.
 */
export async function fetchPackSince(
	remote: Remote,
	wants: string[],
	haves: string[],
	budget: FetchBudget,
): Promise<Chunks | "too big"> {
	const parts = [
		...wants.flatMap((want, index) => pktLine(`want ${want}${index === 0 ? " no-progress agent=githive" : ""}\n`)),
		encoder.encode("0000"),
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
	const answer = await readWithin(response, budget);
	if (answer === "too big") return answer;
	if (!answer.length)
		throw Object.assign(new Error(`fetch failed: an empty answer from ${remote.url}`), { status: 502 });
	return packAfterLines(answer);
}

/** A response's body as it arrives, or "too big" once it would take the budget below nothing. */
async function readWithin(response: Response, budget: FetchBudget): Promise<Chunks | "too big"> {
	const reader = response.body!.getReader();
	const parts: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return new Chunks(parts);
		budget.bytes -= value.length;
		if (budget.bytes < 0) {
			await reader.cancel();
			return "too big";
		}
		parts.push(value);
	}
}

/** The pack after an upload-pack answer's NAK or ACK lines; or the server's error. */
function packAfterLines(answer: Chunks) {
	for (let at = 0; at + 4 <= answer.length;) {
		const head = decoder.decode(answer.bytes(at, at + 4));
		if (head === "PACK") return new Chunks(answer.slice(at));
		const length = Number.parseInt(head, 16);
		if (!length) {
			at += 4;
			continue;
		}
		const line = decoder.decode(answer.bytes(at + 4, at + length)).trim();
		if (line.startsWith("ERR")) throw new Error(`fetch refused: ${line}`);
		at += length;
	}
	throw new Error("fetch failed: the answer had no pack");
}

const PACK_HEADER = 12;
const PACK_TRAILER = 20;

/** A pack's object count, and views of its entries without its header and checksum. */
function packEntries(pack: Chunks) {
	const header = pack.bytes(0, PACK_HEADER);
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const signature = decoder.decode(header.subarray(0, 4));
	if (pack.length < PACK_HEADER + PACK_TRAILER || signature !== "PACK" || view.getUint32(4) !== 2)
		throw new Error("not a version 2 pack");
	return { count: view.getUint32(8), entries: pack.slice(PACK_HEADER, pack.length - PACK_TRAILER) };
}

/**
 * A receive-pack request body, as the parts to send in order: the ref updates, then `packs` joined into one pack.
 * Joining is a new header and checksum around the packs' entries, which are sent as views of them.
 */
function receivePackBody(updates: RefUpdate[], packs: Chunks[]): Uint8Array[] {
	const commands = concat([
		...updates.flatMap((update, index) => {
			const capabilities = index === 0 ? "\0report-status delete-refs agent=githive" : "";
			return pktLine(`${update.from ?? ZERO_OID} ${update.to ?? ZERO_OID} ${update.ref}${capabilities}\n`);
		}),
		encoder.encode("0000"),
	]);
	if (updates.every((update) => update.to === null)) return [commands];
	const parts = packs.map(packEntries);
	const header = new Uint8Array(PACK_HEADER);
	header.set(encoder.encode("PACK"));
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(
		8,
		parts.reduce((total, part) => total + part.count, 0),
	);
	const entries = parts.flatMap((part) => part.entries);
	const checksum = createHash("sha1").update(header);
	for (const entry of entries) checksum.update(entry);
	return [commands, header, ...entries, new Uint8Array(checksum.digest())];
}

/** A request body streamed from `parts`, with its length when the runtime can send one (Workers' FixedLengthStream). */
function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
	if (FixedLength) {
		const { readable, writable } = new FixedLength(length);
		const writer = writable.getWriter();
		void (async () => {
			for (const part of parts) await writer.write(part);
			await writer.close();
		})().catch((err) => writer.abort(err));
		return readable;
	}
	let next = 0;
	return new ReadableStream({
		pull(controller) {
			const part = parts[next++];
			if (part) controller.enqueue(part);
			else controller.close();
		},
	});
}

/** What a receive-pack request did: busy (applied nothing), or each ref's result, `true` or the server's reason. */
export type PushReport = { busy: true } | { unpack: string; refs: Map<string, true | string> };

/**
 * Sends `updates` and `packs`, joined, in one receive-pack request, skipping ref discovery. The server moves a ref
 * only if it's still at `from`. Throws on an HTTP failure, with its status.
 */
export async function receivePack(remote: Remote, updates: RefUpdate[], packs: Chunks[]): Promise<PushReport> {
	const response = await gitFetch(`${remote.url}/git-receive-pack`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-git-receive-pack-request",
			Accept: "application/x-git-receive-pack-result",
			Authorization: basicAuth(remote),
		},
		body: streamOf(receivePackBody(updates, packs)),
		duplex: "half",
	} as RequestInit);
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
