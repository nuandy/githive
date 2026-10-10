import git from "isomorphic-git";
import { gitAuth, gitFetch, http, noteGitRequest } from "./git-http";
import { BOT, isEmptyRepo, type Remote } from "./git";
import { fetchCommits } from "./git-fetch";
import { MemoryFS } from "./memory-fs";
import {
	FORMAT_TRAILER,
	RECORD_FORMAT,
	type Upgrade,
	UPGRADES,
	formatOf,
	newerFormat,
	upgradeState,
} from "./record-format";
import { retryTransient } from "./retry";

// A record log in Git: one ref, appended to by compare-and-swap. An append pushes one commit on the
// tip it was built on, and Git rejects it if the ref moved, so of two writers only one lands.
// Each commit holds state.json, decisions.json and a note file per commit an entry is about.

export interface LogEntry {
	commit: string;
	text: string;
	at: string;
}

export interface LogCommit<S> {
	author: string;
	kind: string;
	entries: LogEntry[];
	state: S;
	/** Unique per append, so a writer can tell whether a push with a lost answer landed. */
	batch: string;
	format?: number;
}

/** Record states shared across Worker instances, by tip. A commit never changes, so they are never stale. */
export interface StateCache {
	get(ref: string, tip: string): Promise<string | undefined>;
	put(ref: string, tip: string, json: string): Promise<void>;
}

/**
 * Where a log's ref points, shared across Worker instances so readers needn't list the ref every time.
 * A landed write updates it before returning, so no read sees a tip older than a finished write.
 */
export interface TipCache {
	/** The kept tip (null: no ref) and its state if kept. `wait` means another reader is listing the ref. */
	get(ref: string, stateKey: string): Promise<{ tip?: string | null; json?: string; gen: number; wait?: boolean }>;
	keep(ref: string, tip: string | null, gen: number): Promise<void>;
	landed(ref: string, parent: string | null, tip: string): Promise<void>;
	stale(ref: string, parent: string | null): Promise<void>;
}

export interface CasLog<S> {
	/** The tip and its commit, or null when nothing has been written. */
	read(): Promise<{ tip: string; commit: LogCommit<S> } | null>;
	/** Like read, but always lists the ref in Git instead of using a kept tip. */
	readFresh?(): Promise<{ tip: string; commit: LogCommit<S> } | null>;
	/** Append on top of `parent` (null for an empty log). Returns the new tip, or null if the tip had moved. */
	append(parent: string | null, commit: LogCommit<S>): Promise<string | null>;
	lastRefusal?: "moved" | "busy" | null;
}

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

function pktLines(body: Uint8Array) {
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

/** Attempts while Artifacts refuses a push as busy, before reporting it as not landed. */
const BUSY_ATTEMPTS = 6;

/**
 * Move `ref` from `from` (null: create it) to `to` in one receive-pack request, skipping ref discovery.
 * The server applies it only if the ref is still at `from`, so this is a compare-and-swap.
 */
async function pushDirect(remote: Remote, ref: string, from: string | null, to: string, fs: MemoryFS, oids: string[]) {
	const { packfile } = await git.packObjects({ fs, dir: DIR, oids });
	const parts = [
		...pktLine(`${from ?? ZERO_OID} ${to} ${ref}\0report-status agent=githive\n`),
		encoder.encode("0000"),
		packfile ?? new Uint8Array(),
	];
	const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	let report: string[] = [];
	// After a server error the push may have applied anyway, and another writer may since have moved the ref past it.
	let unsure = false;
	const refused = async <T>(outcome: T) =>
		unsure && (await landedBehind(remote, ref, to).catch(() => false)) ? true : outcome;
	for (let attempt = 1; ; attempt++) {
		const response = await gitFetch(`${remote.url}/git-receive-pack`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-git-receive-pack-request",
				Accept: "application/x-git-receive-pack-result",
				Authorization: `Basic ${btoa(`x:${remote.token.split("?expires=")[0]}`)}`,
			},
			body,
		});
		noteGitRequest(`${remote.url}/git-receive-pack`, response.status);
		if (response.status >= 500 && attempt < BUSY_ATTEMPTS) {
			// The server failed, perhaps after applying the push.
			await response.body?.cancel();
			unsure = true;
			if ((await serverTip(remote, ref).catch(() => null)) === to) return true;
			await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
			continue;
		}
		if (!response.ok)
			throw new Error(`[${response.status}] push to ${ref} failed: ${(await response.text()).slice(0, 200)}`);
		report = pktLines(new Uint8Array(await response.arrayBuffer()));
		// A busy refusal applied nothing, so it's safe to send again.
		if (!report.some((line) => line.startsWith("ERR") && /busy/i.test(line))) break;
		if (attempt === BUSY_ATTEMPTS) return refused("busy" as const);
		await new Promise((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1_500) * (0.5 + Math.random())));
	}
	if (!report.includes("unpack ok")) throw new Error(`push to ${ref} failed: ${report.join("; ")}`);
	if (report.some((line) => line === `ok ${ref}`)) return true;
	if (report.some((line) => line.startsWith(`ng ${ref}`))) return refused(false);
	throw new Error(`push to ${ref}: unexpected report: ${report.join("; ")}`);
}

/** How far behind the tip to look for a push whose answer was lost. */
const LANDED_DEPTH = 32;

/** Whether `oid` is the ref's tip or one of the commits just behind it. */
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

async function serverTip(remote: Remote, ref: string) {
	// Ask the server whether the log exists, rather than reading a fetch error as "empty".
	const refs = await git
		.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix: ref, ...gitAuth(remote) })
		.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err)));
	return refs.find((r) => r.ref === ref)?.oid ?? null;
}

async function emptyLog() {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	return { fs, tip: null };
}

/**
 * Fetch commit `tip` in one request, without ref discovery. If the ref has moved on,
 * the server refuses it, so fetch the new tip instead.
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

async function openTip(remote: Remote, ref: string) {
	const tip = await serverTip(remote, ref);
	return tip ? fetchAt(remote, ref, tip) : emptyLog();
}

export class GitCasLog<S> implements CasLog<S> {
	readonly ref: string;

	/** The repo at the tip this log last read or wrote, so a writer can append without reading first. */
	private held: { fs: MemoryFS; tip: string } | null = null;

	lastRefusal: "moved" | "busy" | null = null;

	/** Tests set other formats. */
	private readonly format: number;
	private readonly upgrades: Readonly<Record<number, Upgrade>>;
	private readonly states?: StateCache;
	private readonly tips?: TipCache;

	/** `_repo` is unused; it names the repo for callers' readability. */
	constructor(
		private readonly remote: () => Promise<Remote>,
		_repo: string,
		ref: string,
		options: {
			format?: number;
			upgrades?: Readonly<Record<number, Upgrade>>;
			states?: StateCache;
			tips?: TipCache;
		} = {},
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
		// Another reader is listing the ref. Wait for its result rather than all listing at once.
		for (let waited = 0; kept?.wait && waited < TIP_WAIT_MS; waited += 150) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			kept = await this.tips.get(this.ref, this.stateKey).catch(() => null);
		}
		if (kept?.tip !== undefined) {
			// The state is kept too, so no Git request is needed.
			if (kept.tip && kept.json && this.held?.tip !== kept.tip)
				return { tip: kept.tip, commit: JSON.parse(kept.json) as LogCommit<S> };
			return this.readAt(kept.tip);
		}
		const remote = await this.remote();
		const tip = await retryTransient(() => serverTip(remote, this.ref));
		if (kept) void this.tips.keep(this.ref, tip, kept.gen).catch(() => undefined);
		return this.readAt(tip);
	}

	async readFresh(): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		return this.readAt(await retryTransient(() => serverTip(remote, this.ref)));
	}

	/** States are keyed by format, so a GitHive on another format never uses them. */
	private get stateKey() {
		return `${this.ref}@${this.format}`;
	}

	/** Read the log at a known tip, without listing the ref again. */
	async readAt(current: string | null): Promise<{ tip: string; commit: LogCommit<S> } | null> {
		const remote = await this.remote();
		if (!current) return null;
		// Another reader may already have read this tip.
		if (this.held?.tip !== current && this.states) {
			const json = await this.states.get(this.stateKey, current).catch(() => undefined);
			if (json) return { tip: current, commit: JSON.parse(json) as LogCommit<S> };
		}
		const { fs, tip } =
			this.held?.tip === current ? this.held : await retryTransient(() => fetchAt(remote, this.ref, current));
		if (!tip) return null;
		this.held = { fs, tip };
		const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
		const trailer = (name: string) =>
			commit.message.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? fail(`${tip} has no ${name} trailer`);
		const json = async (filepath: string) =>
			JSON.parse(decoder.decode((await git.readBlob({ fs, dir: DIR, oid: tip, filepath })).blob));
		const format = formatOf(commit.message);
		const raw = await json(STATE_FILE);
		const read = {
			tip,
			commit: {
				author: trailer(TRAILERS.author),
				kind: trailer(TRAILERS.kind),
				entries: (await json(DECISIONS_FILE)) as LogEntry[],
				// This GitHive can't upgrade a newer format, so it's read as is.
				state: (format > this.format ? raw : upgradeState<S>(raw, format, this.ref, this.format, this.upgrades)) as S,
				batch: trailer(TRAILERS.batch),
				format,
			},
		};
		if (this.states) void this.states.put(this.stateKey, tip, JSON.stringify(read.commit)).catch(() => undefined);
		return read;
	}

	async tip(): Promise<string | null> {
		return serverTip(await this.remote(), this.ref);
	}

	async append(parent: string | null, commit: LogCommit<S>): Promise<string | null> {
		const remote = await this.remote();
		// Fetch the parent directly, without listing first. A writer that lost a race is then as quick to retry
		// as the winner; otherwise the same writer could win every time.
		const { fs, tip } =
			parent !== null && this.held?.tip === parent
				? this.held
				: parent !== null
					? await retryTransient(() => fetchAt(remote, this.ref, parent))
					: await openTip(remote, this.ref);
		// Built on a stale tip. Drop it from the shared cache, or every writer would build on it until it aged out.
		if (tip !== parent) {
			this.lastRefusal = "moved";
			await this.tips?.stale(this.ref, parent).catch(() => undefined);
			return null;
		}
		// Never overwrite records a newer GitHive wrote; this one would drop what it doesn't know.
		if (tip) {
			const found = formatOf((await git.readCommit({ fs, dir: DIR, oid: tip })).commit.message);
			if (found > this.format) throw newerFormat(found, this.format);
		}

		// Carry the notes forward, adding this commit's entries.
		const files = new Map<string, string>();
		// Only the objects this commit adds need to be pushed.
		const added: string[] = [];
		const write = async (text: string) => {
			const oid = await git.writeBlob({ fs, dir: DIR, blob: encoder.encode(text) });
			added.push(oid);
			return oid;
		};
		if (tip) {
			const { commit: previous } = await git.readCommit({ fs, dir: DIR, oid: tip });
			for (const entry of (await git.readTree({ fs, dir: DIR, oid: previous.tree })).tree)
				files.set(entry.path, entry.oid);
		}
		for (const [about, lines] of notesByCommit(commit.entries)) {
			const existing = files.get(about);
			const before = existing
				? `${decoder.decode((await git.readBlob({ fs, dir: DIR, oid: existing })).blob).trimEnd()}\n`
				: "";
			files.set(about, await write(`${before}${lines.join("\n")}\n`));
		}
		files.set(STATE_FILE, await write(JSON.stringify(commit.state)));
		files.set(DECISIONS_FILE, await write(JSON.stringify(commit.entries)));
		const tree = await git.writeTree({
			fs,
			dir: DIR,
			tree: [...files].map(([path, oid]) => ({ mode: "100644", path, oid, type: "blob" as const })),
		});

		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: {
				message: message(commit, this.format),
				tree,
				parent: tip ? [tip] : [],
				author: signature(),
				committer: signature(),
			},
		});
		await git.writeRef({ fs, dir: DIR, ref: this.ref, value: oid, force: true });
		let landed: boolean | "busy";
		try {
			landed = await pushDirect(remote, this.ref, tip, oid, fs, [...added, tree, oid]);
		} catch (err) {
			this.held = null;
			throw err;
		}
		// Update the shared caches before returning, so the caller's next read sees this write.
		if (landed === true && this.tips) {
			await this.tips.landed(this.ref, tip, oid).catch(() => undefined);
			if (this.states)
				await this.states
					.put(this.stateKey, oid, JSON.stringify({ ...commit, format: this.format }))
					.catch(() => undefined);
		} else if (landed === false) await this.tips?.stale(this.ref, tip).catch(() => undefined);
		this.held = landed === true ? { fs, tip: oid } : null;
		this.lastRefusal = landed === true ? null : landed === "busy" ? "busy" : "moved";
		return landed === true ? oid : null;
	}
}

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

/** Entries not about a commit live only in decisions.json. */
function notesByCommit(entries: LogEntry[]) {
	const byCommit = new Map<string, string[]>();
	for (const e of entries)
		if (isCommitId(e.commit)) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), noteLine(e)]);
	return byCommit;
}

function fail(message: string): never {
	throw new Error(message);
}
