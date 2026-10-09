import git from "isomorphic-git";
import { gitAuth, http } from "./git-http";
import { BOT, isEmptyRepo, type Remote } from "./git";
import { fetchCommits } from "./git-fetch";
import { MemoryFS } from "./memory-fs";
import { FORMAT_TRAILER, RECORD_FORMAT, type Upgrade, UPGRADES, formatOf, newerFormat, upgradeState } from "./record-format";
import { retryTransient } from "./retry";

// A record log in Git: one ref in a repo, appended to by compare-and-swap.
// Reading fetches only the tip; appending pushes one commit on top of the tip
// it was built on, and Git rejects the push if the ref moved meanwhile, so of
// two writers on one tip only one lands and the other reads again. Claims,
// votes and the backlog are kept this way (see toolkit/records.ts).
//
// Each commit's tree holds state.json (the record after this commit) and
// decisions.json (this commit's entries), plus each entry as a Git note on the
// commit it is about. Who wrote it, why, and the record format (see
// record-format.ts) are trailers on its message. Reading upgrades an older
// format's state; records newer than this GitHive knows are read as they are
// and never written over.

/** One entry: what happened, about which commit (if any), and when. */
export interface LogEntry {
	commit: string;
	text: string;
	at: string;
}

/** One commit of a log: who wrote it, its entries, and the state after it. */
export interface LogCommit<S> {
	/** Who wrote it. */
	author: string;
	kind: string;
	entries: LogEntry[];
	state: S;
	/** Unique per append, so a writer can tell whether a push whose answer was lost landed. */
	batch: string;
	/** The record format it was written in (as read; a write is always in the current one). */
	format?: number;
}

/**
 * Record states shared by a log's readers across Worker instances, by ref and
 * tip. A commit never changes, so what's kept for a tip is never stale; only
 * the latest tip per ref need be kept.
 */
export interface StateCache {
	get(ref: string, tip: string): Promise<string | undefined>;
	put(ref: string, tip: string, json: string): Promise<void>;
}

/**
 * Where a log's ref points, kept for its readers across Worker instances so
 * that they needn't list the ref on every read. A write that lands keeps its
 * tip (if the tip kept is the one it built on), so no read sees a tip older
 * than a finished write; a write that finds the tip kept out of date drops
 * it; and a listing is kept only under the generation it began in, so one
 * that raced a write is dropped. One reader at a time lists the ref: the
 * others wait for it, or take the tip kept while it's refreshed.
 */
export interface TipCache {
	/** The tip kept for `ref` (null: no ref), with its state when kept under `stateKey`; or none (`wait`: another reader is listing it), and the generation to keep a listing under. */
	get(ref: string, stateKey: string): Promise<{ tip?: string | null; json?: string; gen: number; wait?: boolean }>;
	keep(ref: string, tip: string | null, gen: number): Promise<void>;
	landed(ref: string, parent: string | null, tip: string): Promise<void>;
	stale(ref: string, parent: string | null): Promise<void>;
}

/** The log as compare-and-swap storage. */
export interface CasLog<S> {
	/** The tip and its commit, or null when nothing has been written. */
	read(): Promise<{ tip: string; commit: LogCommit<S> } | null>;
	/** As read, but from the ref as Git has it now, never a kept tip (see TipCache). */
	readFresh?(): Promise<{ tip: string; commit: LogCommit<S> } | null>;
	/** Append on top of `parent` (null for an empty log): the new tip, or null when the tip had moved. */
	append(parent: string | null, commit: LogCommit<S>): Promise<string | null>;
	/** Why the last append didn't land: another writer moved the tip, or the server stayed busy. */
	lastRefusal?: "moved" | "busy" | null;
}

/** A note line: when, then the entry. Multi-line text is indented under it. */
function noteLine(entry: LogEntry) {
	const [first, ...rest] = entry.text.trim().split("\n");
	return [`${entry.at.slice(0, 19).replace("T", " ")}Z  ${first}`, ...rest.map((l) => `    ${l}`)].join("\n");
}

const DIR = "/log";
const STATE_FILE = "state.json";
const DECISIONS_FILE = "decisions.json";

const TRAILERS = { author: "GitHive-Author", kind: "GitHive-Kind", batch: "GitHive-Batch" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isCommitId = (id: string) => /^[0-9a-f]{40}$/.test(id);
const signature = () => ({ ...BOT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 });


const ZERO_OID = "0".repeat(40);

/** How long a reader waits for another's listing of a ref before listing it too. */
const TIP_WAIT_MS = 3_000;

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
	const parts = [...pktLine(`${from ?? ZERO_OID} ${to} ${ref}\0report-status agent=githive\n`), encoder.encode("0000"), packfile ?? new Uint8Array()];
	const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	let report: string[] = [];
	/** A push was answered with a server error: it may have applied all the same. */
	let unsure = false;
	// Refused, or still busy, after an answer that was lost: if the push applied, another writer may have moved the ref on
	// since, and the ref is no longer at `to`; then it's among the commits just behind the ref.
	const refused = async <T>(outcome: T) => (unsure && (await landedBehind(remote, ref, to).catch(() => false)) ? true : outcome);
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
			unsure = true;
			if ((await serverTip(remote, ref).catch(() => null)) === to) return true;
			await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
			continue;
		}
		if (!response.ok) throw new Error(`[${response.status}] push to ${ref} failed: ${(await response.text()).slice(0, 200)}`);
		report = pktLines(new Uint8Array(await response.arrayBuffer()));
		// Busy: the repo is taking another push. Nothing was applied, so it is safe to send again.
		if (!report.some((line) => line.startsWith("ERR") && /busy/i.test(line))) break;
		// Still busy: report it as not landed, and the caller reads the log and tries again.
		if (attempt === BUSY_ATTEMPTS) return refused("busy" as const);
		await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
	}
	if (!report.includes("unpack ok")) throw new Error(`push to ${ref} failed: ${report.join("; ")}`);
	if (report.some((line) => line === `ok ${ref}`)) return true;
	if (report.some((line) => line.startsWith(`ng ${ref}`))) return refused(false);
	throw new Error(`push to ${ref}: unexpected report: ${report.join("; ")}`);
}

/** How many commits behind a ref's tip a push whose answer was lost is looked for. */
const LANDED_DEPTH = 32;

/** Whether `oid` is the ref's tip or one of the commits just behind it (a record log is a line of commits). */
async function landedBehind(remote: Remote, ref: string, oid: string) {
	const tip = await serverTip(remote, ref);
	if (!tip) return false;
	if (tip === oid) return true;
	const { fs } = await fetchCommits(remote, [tip], DIR, { depth: LANDED_DEPTH });
	for (let at: string | undefined = tip, n = 0; at && n < LANDED_DEPTH; n++) {
		if (at === oid) return true;
		at = (await git.readCommit({ fs, dir: DIR, oid: at }).catch(() => null))?.commit.parent[0];
	}
	return false;
}

/** Where the ref points on the server, or null if it doesn't exist (one request). */
async function serverTip(remote: Remote, ref: string) {
	// Ask the server whether the log exists, rather than reading a fetch error as "empty".
	const refs = await git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: ref, ...gitAuth(remote) }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
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

export class GitCasLog<S> implements CasLog<S> {
	/** The ref this log is kept at: named in errors, so a failure says which record it was. */
	readonly ref: string;

	/**
	 * The in-memory repo this log last wrote or read, at that tip. A writer
	 * appends on top of its own last commit, so it needn't read the log first:
	 * the push alone says whether the tip moved.
	 */
	private held: { fs: MemoryFS; tip: string } | null = null;

	lastRefusal: "moved" | "busy" | null = null;

	/** The format this log writes and upgrades to, and how; tests rehearse other formats. */
	private readonly format: number;
	private readonly upgrades: Readonly<Record<number, Upgrade>>;
	/** Commits this log's other readers (other Worker instances) already read, by tip (see StateCache). */
	private readonly states?: StateCache;
	/** Where its ref points, as other readers last listed it (see TipCache). */
	private readonly tips?: TipCache;

	/** The log at `ref` in the repo `remote` reaches (`_repo` names it, for callers' readability). */
	constructor(
		private readonly remote: () => Promise<Remote>,
		_repo: string,
		ref: string,
		options: { format?: number; upgrades?: Readonly<Record<number, Upgrade>>; states?: StateCache; tips?: TipCache } = {},
	) {
		this.ref = ref;
		this.format = options.format ?? RECORD_FORMAT;
		this.upgrades = options.upgrades ?? UPGRADES;
		if (options.states) this.states = options.states;
		if (options.tips) this.tips = options.tips;
	}

	async read(): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		if (!this.tips) return this.readFresh();
		let kept = await this.tips.get(this.ref, this.stateKey).catch(() => null);
		// Another reader is listing it: wait a moment for what it finds, rather than all list at once.
		for (let waited = 0; kept?.wait && waited < TIP_WAIT_MS; waited += 150) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			kept = await this.tips.get(this.ref, this.stateKey).catch(() => null);
		}
		if (kept?.tip !== undefined) {
			// Kept with its state: no Git request at all.
			if (kept.tip && kept.json && this.held?.tip !== kept.tip) return { tip: kept.tip, commit: JSON.parse(kept.json) as LogCommit<S> };
			return this.readAt(kept.tip);
		}
		const remote = await this.remote();
		const tip = await retryTransient(() => serverTip(remote, this.ref));
		if (kept) void this.tips.keep(this.ref, tip, kept.gen).catch(() => undefined);
		return this.readAt(tip);
	}

	async readFresh(): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		// Reads change nothing, so a brief server failure is simply retried.
		return this.readAt(await retryTransient(() => serverTip(remote, this.ref)));
	}

	/** States are kept with the format they were read in, so a GitHive reading another format never takes one. */
	private get stateKey() {
		return `${this.ref}@${this.format}`;
	}

	/** Read the log, already knowing where its ref points (from a listing): no need to ask the server again. */
	async readAt(current: string | null): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		if (!current) return null;
		// Another reader already read this tip: a commit never changes, so its state is the same (no fetch).
		if (this.held?.tip !== current && this.states) {
			const json = await this.states.get(this.stateKey, current).catch(() => undefined);
			if (json) return { tip: current, commit: JSON.parse(json) as LogCommit<S> };
		}
		// Fetch only if the tip moved since this log last saw it.
		const { fs, tip } = this.held?.tip === current ? this.held : await retryTransient(() => fetchAt(remote, this.ref, current));
		if (!tip) return null;
		this.held = { fs, tip };
		const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
		const trailer = (name: string) => commit.message.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? fail(`${tip} has no ${name} trailer`);
		const json = async (filepath: string) => JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: tip, filepath })).blob));
		const format = formatOf(commit.message);
		const raw = await json(STATE_FILE);
		const read = {
			tip,
			commit: {
				author: trailer(TRAILERS.author),
				kind: trailer(TRAILERS.kind),
				entries: (await json(DECISIONS_FILE)) as LogEntry[],
				// A newer format is read as it is: this GitHive can't know how to upgrade it.
				state: (format > this.format ? raw : upgradeState<S>(raw, format, this.ref, this.format, this.upgrades)) as S,
				batch: trailer(TRAILERS.batch),
				format,
			},
		};
		// For the other readers: kept by tip, so it's never stale.
		if (this.states) void this.states.put(this.stateKey, tip, JSON.stringify(read.commit)).catch(() => undefined);
		return read;
	}

	/** Where the ref points now, without reading what's there. */
	async tip(): Promise<string | null> {
		return serverTip(await this.remote(), this.ref);
	}

	async append(parent: string | null, commit: LogCommit<S>): Promise<string | null> {
		const remote = await this.remote();
		// Not the tip this log holds: fetch the one it was built on (a read just found it), with no listing first, so
		// a writer that lost a race is as quick to try again as the one that won (else that one can win every time).
		// If the ref has moved on, the server says so and the new tip comes back instead.
		const { fs, tip } = parent !== null && this.held?.tip === parent ? this.held : parent !== null ? await retryTransient(() => fetchAt(remote, this.ref, parent)) : await openTip(remote, this.ref);
		// Built on a stale tip: no need to ask the server. If that's the tip kept for readers (a write's
		// keeping of its own was lost), it's out of date: drop it, or every writer would build on it until it aged out.
		if (tip !== parent) {
			this.lastRefusal = "moved";
			await this.tips?.stale(this.ref, parent).catch(() => undefined);
			return null;
		}
		// Never write over records a newer GitHive wrote: this one can't keep what it doesn't know.
		if (tip) {
			const found = formatOf((await git.readCommit({ fs, dir: DIR, oid: tip })).commit.message);
			if (found > this.format) throw newerFormat(found, this.format);
		}

		// Carry the notes forward, adding this commit's entries to them.
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
			commit: { message: message(commit, this.format), tree, parent: tip ? [tip] : [], author: signature(), committer: signature() },
		});
		await git.writeRef({ fs, dir: DIR, ref: this.ref, value: oid, force: true });
		let landed: boolean | "busy";
		try {
			landed = await pushDirect(remote, this.ref, tip, oid, fs, [...added, tree, oid]);
		} catch (err) {
			this.held = null;
			throw err;
		}
		// Kept for the other readers before returning, so that anything this write's caller does next reads it (see TipCache):
		// landed, its tip and state; refused as moved, the tip it built on is out of date.
		if (landed === true && this.tips) {
			await this.tips.landed(this.ref, tip, oid).catch(() => undefined);
			if (this.states) await this.states.put(this.stateKey, oid, JSON.stringify({ ...commit, format: this.format })).catch(() => undefined);
		} else if (landed === false) await this.tips?.stale(this.ref, tip).catch(() => undefined);
		// Not landed: the ref moved since `tip` and compare-and-swap lost, or the server stayed busy.
		this.held = landed === true ? { fs, tip: oid } : null;
		this.lastRefusal = landed === true ? null : landed === "busy" ? "busy" : "moved";
		return landed === true ? oid : null;
	}
}

/** The commit message: a summary of the entries, then the trailers. */
function message<S>(commit: LogCommit<S>, format: number) {
	const first = (text: string) => text.trim().split("\n")[0];
	const title = commit.entries.length ? first(commit.entries[0].text) : commit.kind;
	const summary = commit.entries.map((e) => `- ${first(e.text)}`).join("\n");
	const trailers = [
		`${TRAILERS.author}: ${commit.author}`,
		`${TRAILERS.kind}: ${commit.kind}`,
		`${TRAILERS.batch}: ${commit.batch}`,
		`${FORMAT_TRAILER}: ${format}`,
	].join("\n");
	return `${title}\n\n${summary ? `${summary}\n\n` : ""}${trailers}\n`;
}

/** Entry lines grouped by the commit they are about; entries not about a commit live only in decisions.json. */
function notesByCommit(entries: LogEntry[]) {
	const byCommit = new Map<string, string[]>();
	for (const e of entries) if (isCommitId(e.commit)) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), noteLine(e)]);
	return byCommit;
}

function fail(message: string): never {
	throw new Error(message);
}
