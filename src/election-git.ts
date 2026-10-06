import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CasLog, CommitKind, LogCommit } from "./election";
import { BOT, isEmptyRepo, type Remote } from "./git";
import { type LedgerEntry, noteLine, notesRef } from "./ledger";
import { fetchCommits } from "./git-fetch";
import { MemoryFS } from "./memory-fs";
import { retryTransient } from "./retry";

// The elected coordinator's log in Git: the task's notes ref in the project
// repo. Reading fetches only the tip; appending pushes one commit on top of the
// tip it was built on, and Git rejects the push if the ref moved meanwhile.
//
// Each commit's tree holds the decisions as Git notes on the commits they are
// about (so `git notes --ref blueprint/<task> show <commit>` reads them), plus
// state.json (the task after this commit) and decisions.json (this commit's
// decisions, losslessly). Who leads, until when, and why the commit was made
// are trailers on its message.

const DIR = "/log";
const STATE_FILE = "state.json";
const DECISIONS_FILE = "decisions.json";

const TRAILERS = { term: "Blueprint-Term", leader: "Blueprint-Leader", leaseUntil: "Blueprint-Lease-Until", kind: "Blueprint-Kind", batch: "Blueprint-Batch" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isCommitId = (id: string) => /^[0-9a-f]{40}$/.test(id);
const signature = () => ({ ...BOT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 });

const onAuth = (remote: Remote) => () => ({ username: "x", password: remote.token.split("?expires=")[0] });

const ZERO_OID = "0".repeat(40);

/** A Git pkt-line: four hex digits of length (including themselves), then the payload. */
function pktLine(line: string) {
	const payload = encoder.encode(line);
	return [encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload];
}

/** The pkt-lines of a response body, as text. */
function pktLines(body: Uint8Array) {
	const lines: string[] = [];
	for (let at = 0; at + 4 <= body.length; ) {
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

/**
 * Move `ref` from `from` (null: create it) to `to`, sending `oids` in one
 * receive-pack request: no discovery round trip first. The server applies the
 * update only if the ref is still at `from`, so this is a compare-and-swap.
 * Returns whether it landed.
 */
/** Pushes Artifacts refused as busy (several at once on one repo) before reporting one as not landed. */
const BUSY_ATTEMPTS = 6;

async function pushDirect(remote: Remote, ref: string, from: string | null, to: string, fs: MemoryFS, oids: string[]) {
	const { packfile } = await git.packObjects({ fs, dir: DIR, oids });
	const parts = [...pktLine(`${from ?? ZERO_OID} ${to} ${ref}\0report-status agent=blueprint\n`), encoder.encode("0000"), packfile ?? new Uint8Array()];
	const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	let report: string[] = [];
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(`${remote.url}/git-receive-pack`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-git-receive-pack-request",
				Accept: "application/x-git-receive-pack-result",
				Authorization: `Basic ${btoa(`x:${remote.token.split("?expires=")[0]}`)}`,
			},
			body,
		});
		if (response.status >= 500 && attempt < BUSY_ATTEMPTS) {
			// The server failed, perhaps after applying the push: if the ref is now at `to`, it landed.
			await response.body?.cancel();
			if ((await serverTip(remote, ref).catch(() => null)) === to) return true;
			await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
			continue;
		}
		if (!response.ok) throw new Error(`[${response.status}] push to ${ref} failed: ${(await response.text()).slice(0, 200)}`);
		report = pktLines(new Uint8Array(await response.arrayBuffer()));
		// Busy: the repo is taking another push. Nothing was applied, so it is safe to send again.
		if (!report.some((line) => line.startsWith("ERR") && /busy/i.test(line))) break;
		// Still busy: report it as not landed, and the caller reads the log and tries again.
		if (attempt === BUSY_ATTEMPTS) return "busy" as const;
		await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
	}
	if (!report.includes("unpack ok")) throw new Error(`push to ${ref} failed: ${report.join("; ")}`);
	if (report.some((line) => line === `ok ${ref}`)) return true;
	if (report.some((line) => line.startsWith(`ng ${ref}`))) return false;
	throw new Error(`push to ${ref}: unexpected report: ${report.join("; ")}`);
}

/** Where the ref points on the server, or null if it doesn't exist (one request). */
async function serverTip(remote: Remote, ref: string) {
	// Ask the server whether the log exists, rather than reading a fetch error as "empty".
	const refs = await git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: ref, onAuth: onAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	return refs.find((r) => r.ref === ref)?.oid ?? null;
}

/** An empty in-memory repo for a log with nothing in it. */
async function emptyLog() {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	return { fs, tip: null };
}

/**
 * The commit `tip` of `ref`, fetched alone in one request (no ref discovery,
 * and no need for the repo to have a HEAD). If the ref has moved on from it
 * meanwhile, the server won't serve it: fetch the new tip instead.
 */
async function fetchAt(remote: Remote, ref: string, tip: string): Promise<{ fs: MemoryFS; tip: string | null }> {
	try {
		return { fs: (await fetchCommits(remote, [tip], DIR)).fs, tip };
	} catch (err) {
		if (!/not our ref|fetch refused/i.test(String(err))) throw err;
		const now = await serverTip(remote, ref);
		return now ? { fs: (await fetchCommits(remote, [now], DIR)).fs, tip: now } : emptyLog();
	}
}

/** The ref's tip in an in-memory repo, or an empty repo if the ref doesn't exist. */
async function openTip(remote: Remote, ref: string) {
	const tip = await serverTip(remote, ref);
	return tip ? fetchAt(remote, ref, tip) : emptyLog();
}

/**
 * A remote whose token is minted once and reused while fresh. Minting takes
 * several Artifacts calls, so doing it per read or push dominated their cost.
 * Tokens last ten minutes by default; this renews well before.
 */
export function cachedRemote(mint: () => Promise<Remote>, freshForMs = 5 * 60_000, now: () => number = Date.now) {
	let cached: { remote: Promise<Remote>; until: number } | null = null;
	return () => {
		if (!cached || now() >= cached.until) {
			const remote = mint();
			cached = { remote, until: now() + freshForMs };
			// A failed mint isn't kept.
			remote.catch(() => (cached = null));
		}
		return cached.remote;
	};
}

/**
 * Every decision a task's log recorded, oldest first: each commit carries the
 * decisions it made. (Commits from a fixed Coordinator's ledger, before a task
 * moved to the elected coordinator, carry none and are skipped.)
 */
export async function readDecisionHistory(remote: Remote, taskId: string): Promise<LedgerEntry[]> {
	const ref = notesRef(taskId);
	const tip = await retryTransient(() => serverTip(remote, ref));
	if (!tip) return [];
	const { fs } = await retryTransient(() => fetchCommits(remote, [tip], DIR, { history: true }));
	const entries: LedgerEntry[] = [];
	for (const { oid } of (await git.log({ fs, dir: DIR, ref: tip })).reverse()) {
		const blob = await git.readBlob({ fs, dir: DIR, oid, filepath: DECISIONS_FILE }).catch(() => null);
		if (blob) entries.push(...(JSON.parse(decoder.decode(blob.blob)) as LedgerEntry[]));
	}
	return entries;
}

/** A task's lease ref: who leads, until when. Beside the decision log, so heartbeats don't grow it. */
export const leaseRef = (taskId: string) => `refs/notes/blueprint-lease/${taskId}`;

export class GitCasLog<S> implements CasLog<S> {
	private readonly ref: string;

	/**
	 * The in-memory repo this log last wrote or read, at that tip. A leader
	 * appends on top of its own last commit, so it needn't read the log first:
	 * the push alone says whether the tip moved.
	 */
	private held: { fs: MemoryFS; tip: string } | null = null;

	lastRefusal: "moved" | "busy" | null = null;

	/** The task's decision log, or another ref (its lease ref) with the same commits. */
	constructor(
		private readonly remote: () => Promise<Remote>,
		taskId: string,
		ref = notesRef(taskId),
	) {
		this.ref = ref;
	}

	async read(): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		// Reads change nothing, so a brief server failure is simply retried.
		return this.readAt(await retryTransient(() => serverTip(remote, this.ref)));
	}

	/** Read the log, already knowing where its ref points (from a listing): no need to ask the server again. */
	async readAt(current: string | null): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		if (!current) return null;
		// Fetch only if the tip moved since this log last saw it.
		const { fs, tip } = this.held?.tip === current ? this.held : await retryTransient(() => fetchAt(remote, this.ref, current));
		if (!tip) return null;
		this.held = { fs, tip };
		const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
		const trailer = (name: string) => commit.message.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? fail(`${tip} has no ${name} trailer`);
		const json = async (filepath: string) => JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: tip, filepath })).blob));
		return {
			tip,
			commit: {
				term: Number(trailer(TRAILERS.term)),
				leader: trailer(TRAILERS.leader),
				leaseUntil: Number(trailer(TRAILERS.leaseUntil)),
				kind: trailer(TRAILERS.kind) as CommitKind,
				entries: (await json(DECISIONS_FILE)) as LedgerEntry[],
				state: (await json(STATE_FILE)) as S,
				batch: trailer(TRAILERS.batch),
			},
		};
	}

	/** Where the ref points now, without reading what's there (it may predate this log's format, as a fixed Coordinator's ledger does). */
	async tip(): Promise<string | null> {
		return serverTip(await this.remote(), this.ref);
	}

	async append(parent: string | null, commit: LogCommit<S>): Promise<string | null> {
		const remote = await this.remote();
		const { fs, tip } = parent !== null && this.held?.tip === parent ? this.held : await openTip(remote, this.ref);
		// Built on a stale tip: no need to ask the server.
		if (tip !== parent) return null;

		// Carry the notes forward, adding this commit's decisions to them.
		const files = new Map<string, string>();
		/** Objects this commit adds: the only ones the push has to send. */
		const added: string[] = [];
		const write = async (text: string) => {
			const oid = await git.writeBlob({ fs, dir: DIR, blob: encoder.encode(text) });
			added.push(oid);
			return oid;
		};
		if (tip) {
			const { commit: previous } = await git.readCommit({ fs, dir: DIR, oid: tip });
			for (const entry of (await git.readTree({ fs, dir: DIR, oid: previous.tree })).tree) files.set(entry.path, entry.oid);
		}
		for (const [about, lines] of notesByCommit(commit.entries)) {
			const existing = files.get(about);
			const before = existing ? `${decoder.decode((await git.readBlob({ fs, dir: DIR, oid: existing })).blob).trimEnd()}\n` : "";
			files.set(about, await write(`${before}${lines.join("\n")}\n`));
		}
		files.set(STATE_FILE, await write(JSON.stringify(commit.state)));
		files.set(DECISIONS_FILE, await write(JSON.stringify(commit.entries)));
		const tree = await git.writeTree({ fs, dir: DIR, tree: [...files].map(([path, oid]) => ({ mode: "100644", path, oid, type: "blob" as const })) });

		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: { message: message(commit), tree, parent: tip ? [tip] : [], author: signature(), committer: signature() },
		});
		await git.writeRef({ fs, dir: DIR, ref: this.ref, value: oid, force: true });
		let landed: boolean | "busy";
		try {
			landed = await pushDirect(remote, this.ref, tip, oid, fs, [...added, tree, oid]);
		} catch (err) {
			this.held = null;
			throw err;
		}
		// Not landed: the ref moved since `tip` and compare-and-swap lost, or the server stayed busy.
		this.held = landed === true ? { fs, tip: oid } : null;
		this.lastRefusal = landed === true ? null : landed === "busy" ? "busy" : "moved";
		return landed === true ? oid : null;
	}
}

/** The commit message: a summary of the decisions, then the trailers. */
function message<S>(commit: LogCommit<S>) {
	const first = (text: string) => text.trim().split("\n")[0];
	const titles: Record<string, string> = {
		genesis: "Genesis: the task's first state",
		term: `Term ${commit.term}: ${commit.leader} leads`,
		election: `Election: ${commit.leader} leads term ${commit.term}`,
		heartbeat: `Heartbeat: ${commit.leader}, term ${commit.term}`,
		resignation: `Resignation: ${commit.leader} ends term ${commit.term}`,
	};
	const title = commit.entries.length ? first(commit.entries[0].text) : (titles[commit.kind] ?? commit.kind);
	const summary = commit.entries.map((e) => `- ${first(e.text)}`).join("\n");
	const trailers = [
		`${TRAILERS.term}: ${commit.term}`,
		`${TRAILERS.leader}: ${commit.leader}`,
		`${TRAILERS.leaseUntil}: ${commit.leaseUntil}`,
		`${TRAILERS.kind}: ${commit.kind}`,
		`${TRAILERS.batch}: ${commit.batch}`,
	].join("\n");
	return `${title}\n\n${summary ? `${summary}\n\n` : ""}${trailers}\n`;
}

/** Decision lines grouped by the commit they are about; decisions not about a commit live only in decisions.json. */
function notesByCommit(entries: LedgerEntry[]) {
	const byCommit = new Map<string, string[]>();
	for (const e of entries) if (isCommitId(e.commit)) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), noteLine(e)]);
	return byCommit;
}

function fail(message: string): never {
	throw new Error(message);
}
