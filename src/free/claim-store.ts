import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CasLog } from "../election";
import { GitCasLog } from "../election-git";
import { isEmptyRepo, type Remote } from "../git";
import { fetchCommits } from "../git-fetch";
import { retryTransient } from "../retry";
import { activeClaims, claim, conflictsWith, release, releaseStale, withdraw, type ClaimRecord, type Conflict, type Registry, type ReleaseRecord } from "./claims";
import { appendRecord } from "./records";
import { ancestorsOf, changeRef, changeRepoOf, decodeShard, encodeShard, isWide, recordsRepoOf, shardOf, shardRef, shardsPrefix } from "./shards";
import type { Stamper } from "./stamp";

// Where a repo's claims are kept: in its claims registry until the load calls
// for more, then also split by path into shards below it (see shards.ts).
// Callers see the same thing either way: the claims in force, one per change.

export interface ClaimsView {
	/** The claims in force, one per change (a change's records across shards as one). */
	claims: ClaimRecord[];
	/** Every release recorded, in the shards read. */
	released: ReleaseRecord[];
	/** Each record ref read, by shard ("" for the registry itself), at the tip read: what a merge cites. */
	tips: Map<string, string>;
}

export interface ClaimInput {
	change: string;
	agent: string;
	paths: string[];
	intent: string;
	/** A claim in the way idle this long is released as stale. */
	staleAfterMs?: number;
	now?: number;
}

export type ClaimOutcome = { ok: true } | { ok: false; conflicts: Conflict[] };
export type ReleaseOutcome = { ok: true } | { ok: false; refused: string };

export interface ChangeView {
	claim?: ClaimRecord;
	/** The change's releases, oldest first. */
	released: ReleaseRecord[];
}

export interface ClaimStore {
	/** Every claim in force. */
	read(): Promise<ClaimsView>;
	/** One change's claim and releases, reading only what holds them where it can. */
	readChange(change: string): Promise<ChangeView>;
	/** What bears on merging `files` for `change`: its own claim and any covering the files, at the tips read (for citing). */
	readScope(change: string, files: string[]): Promise<ClaimsView>;
	claim(input: ClaimInput, stamper?: Stamper): Promise<ClaimOutcome>;
	release(input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper): Promise<ReleaseOutcome>;
	releaseStale(input: { change: string; agent: string; staleAfterMs: number; now?: number }, stamper?: Stamper): Promise<ReleaseOutcome>;
	/** What a merge of `files` cites as the claims it checked (the Blueprint-Claims trailer), from the view it checked them in. */
	cite(view: ClaimsView, files: string[], own?: ClaimRecord): string;
}

export interface StoreInput {
	repo: string;
	/** The claims registry's state: whether, and how deep, its claims are sharded. */
	registry: Registry | null | undefined;
	/** The claims registry's log, and its head if the caller has just read it. */
	root: CasLog<Registry>;
	rootHead?: Awaited<ReturnType<CasLog<Registry>["read"]>>;
	remote: () => Promise<Remote>;
	/** A records repo's credentials, when the registry spreads shards over records repos. */
	recordsRemote?: (k: number) => Promise<Remote>;
	/** A shard's log in the project repo, if the caller keeps them across calls. */
	log?: (ref: string) => CasLog<Registry> & Pick<GitCasLog<Registry>, "readAt">;
}

/**
 * Shard states by commit, for the isolate. A commit never changes, so a state
 * once read stays right; only states already read are kept (no request waits
 * on another's I/O).
 */
const shardStates = new Map<string, Registry>();

/** How many records repos a release writes to at once. */
const RELEASE_REPOS_AT_ONCE = 4;
const decoder = new TextDecoder();

/**
 * Every shard under `prefix`, at its tip: one listing, then one fetch for all
 * the shards whose tips aren't known yet. Brief server failures are retried.
 */
async function readAllShards(remote: Remote, prefix: string) {
	return readListed(remote, async (onAuth) => (await listRefs(remote, prefix, onAuth)).filter((r) => r.ref.startsWith(prefix)));
}

/** These refs (where they exist) at their tips: one listing (of the prefix they share), then one fetch for the commits not known yet. */
async function readRefs(remote: Remote, refs: string[]) {
	const wanted = new Set(refs);
	return readListed(remote, async (onAuth) => (await listRefs(remote, sharedPrefix(refs), onAuth)).filter((r) => wanted.has(r.ref)));
}

/** The longest prefix every ref starts with. */
function sharedPrefix(refs: string[]) {
	let prefix = refs[0] ?? "";
	for (const ref of refs) while (!ref.startsWith(prefix)) prefix = prefix.slice(0, -1);
	return prefix;
}

const listRefs = (remote: Remote, prefix: string, onAuth: () => { username: string; password: string }) =>
	retryTransient(() => git.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, onAuth }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))));

/** Refs as `list` finds them, with their states: commits not known yet are fetched in one request. */
async function readListed(remote: Remote, list: (onAuth: () => { username: string; password: string }) => Promise<{ ref: string; oid: string }[]>): Promise<{ ref: string; tip: string; state: Registry }[]> {
	const onAuth = () => ({ username: "x", password: remote.token.split("?expires=")[0] });
	for (let attempt = 1; ; attempt++) {
		const listed = await list(onAuth);
		const missing = [...new Set(listed.map((r) => r.oid).filter((oid) => !shardStates.has(oid)))];
		try {
			if (missing.length) {
				const { fs, dir } = await retryTransient(() => fetchCommits(remote, missing));
				for (const oid of missing) shardStates.set(oid, JSON.parse(decoder.decode((await git.readBlob({ fs, dir, oid, filepath: "state.json" })).blob)) as Registry);
			}
		} catch (err) {
			// A ref moved between the listing and the fetch: its old tip is no longer served. List again.
			if (attempt < 3 && /not our ref|fetch refused/i.test(String(err))) continue;
			throw err;
		}
		return listed.map((r) => ({ ref: r.ref, tip: r.oid, state: shardStates.get(r.oid)! }));
	}
}

export function claimStore(input: StoreInput): ClaimStore {
	return new Claims(input);
}

/** The registry, as a shard: above every other. */
const ROOT = "";

/** A claim whose paths fall in more shards than this is written once, in the shard that holds all of them. */
const MAX_SPREAD = 4;

type Entry = { shard: string; tip: string; state: Registry };

/** The shard every one of `shards` is in (ROOT if they share no first segment). */
function commonShard(shards: string[]) {
	const split = shards.map((s) => s.split("/"));
	const common: string[] = [];
	for (let i = 0; split.every((parts) => i < parts.length && parts[i] === split[0][i]); i++) common.push(split[0][i]);
	return common.join("/");
}

/**
 * A repo's claims, in its registry and, once sharded, in per-path shards
 * below it. Unsharded, every claim is a write to the registry: the cheapest
 * there is while few agents write. Sharded, a claim is written to the shard of
 * its paths (or, spread over many, the one shard holding them all), and
 * checks, once written, the shards above it (the registry among them) and, if
 * it covers more than its own shard, below it. Of two overlapping claims at
 * different levels at least one sees the other, since each writes before it
 * looks. The registry is sharded at most once (see shardClaims); a claim that
 * lands in the registry after that checks every shard, like any claim there.
 */
class Claims implements ClaimStore {
	private readonly logs = new Map<string, CasLog<Registry> & Pick<GitCasLog<Registry>, "readAt">>();
	private depth: number;
	private recordsRepos: number;
	private alwaysIndexed: boolean;
	private known?: Awaited<ReturnType<CasLog<Registry>["read"]>>;

	constructor(private readonly input: StoreInput) {
		this.depth = input.registry?.shardDepth ?? 0;
		this.recordsRepos = input.registry?.recordsRepos ?? 0;
		this.alwaysIndexed = !!input.registry?.shardedAt;
		this.known = input.rootHead;
	}

	private get sharded() {
		return this.depth > 0;
	}

	/** Learn from a registry state read or written on whether it's sharded: it only ever turns on. */
	private learn(state: Registry | null | undefined) {
		if (!state?.shardDepth || this.sharded) return;
		this.depth = state.shardDepth;
		this.recordsRepos = state.recordsRepos ?? 0;
		this.alwaysIndexed = !!state.shardedAt;
	}

	/** How many records repos the shards are spread over (0: they're in the project repo). */
	private get spread() {
		return this.input.recordsRemote ? this.recordsRepos : 0;
	}

	/** Which repo holds a shard: -1 for the project repo (the registry, and shards when they aren't spread), else a records repo. */
	private repoOf(shard: string) {
		return shard !== ROOT && this.spread ? recordsRepoOf(shard, this.spread) : -1;
	}

	private remote(k: number) {
		return k < 0 ? this.input.remote() : this.input.recordsRemote!(k);
	}

	/** Every repo that holds shards. */
	private remotes() {
		return this.spread ? Array.from({ length: this.spread }, (_, k) => this.input.recordsRemote!(k)) : [this.input.remote()];
	}

	private logOf(shard: string) {
		if (shard === ROOT) return this.input.root;
		const ref = shardRef(this.input.repo, shard);
		let log = this.logs.get(ref);
		if (!log) this.logs.set(ref, (log = (!this.spread && this.input.log?.(ref)) || new GitCasLog<Registry>(() => this.remote(this.repoOf(shard)), this.input.repo, ref)));
		return log;
	}

	/** The registry: the head the caller just read, once; after that, the ref again. */
	private async readRoot(): Promise<Entry[]> {
		const head = this.known !== undefined ? this.known : await this.input.root.read();
		this.known = undefined;
		this.learn(head?.commit.state);
		return head ? [{ shard: ROOT, tip: head.tip, state: head.commit.state }] : [];
	}

	/** The shards whose refs start with `prefix`, with their tips: one listing per repo holding shards. */
	private async list(prefix = shardsPrefix(this.input.repo)) {
		const base = shardsPrefix(this.input.repo);
		const listed = await Promise.all(
			this.remotes().map(async (pending) => {
				const remote = await pending;
				const refs = await retryTransient(() =>
					git
						.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, onAuth: () => ({ username: "x", password: remote.token.split("?expires=")[0] }) })
						.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))),
				);
				return refs.filter((r) => r.ref.startsWith(prefix)).map((r) => decodeShard(r.ref.slice(base.length)));
			}),
		);
		return listed.flat();
	}

	/** Every shard at its tip: per repo, one listing and one fetch. */
	private async readAll(): Promise<Entry[]> {
		const prefix = shardsPrefix(this.input.repo);
		const shards = (await Promise.all(this.remotes().map(async (remote) => readAllShards(await remote, prefix)))).flat();
		return shards.map(({ ref, tip, state }) => ({ shard: decodeShard(ref.slice(prefix.length)), tip, state }));
	}

	/** These shards (where they exist) at their tips: per repo, one listing and one fetch. */
	private async readShards(shards: string[]): Promise<Entry[]> {
		const byRepo = new Map<number, string[]>();
		for (const shard of new Set(shards)) if (shard !== ROOT) byRepo.set(this.repoOf(shard), [...(byRepo.get(this.repoOf(shard)) ?? []), shard]);
		const read = await Promise.all([...byRepo].map(async ([k, group]) => readRefs(await this.remote(k), group.map((s) => shardRef(this.input.repo, s)))));
		const prefix = shardsPrefix(this.input.repo);
		return read.flat().map((entry) => ({ shard: decodeShard(entry.ref.slice(prefix.length)), tip: entry.tip, state: entry.state }));
	}

	/** The registry and, sharded, every shard. */
	private async readEverything(): Promise<Entry[]> {
		const early = this.sharded ? this.readAll() : null;
		early?.catch(() => undefined);
		const root = await this.readRoot();
		// Unsharded as far as this store knew, but the registry says otherwise: read the shards too.
		return [...root, ...(early ? await early : this.sharded ? await this.readAll() : [])];
	}

	/** The view of some records: their claims (one per change), releases and tips. */
	private viewOf(entries: Entry[]): ClaimsView {
		return {
			claims: mergeByChange(entries.flatMap((e) => activeClaims(e.state))),
			released: entries.flatMap((e) => e.state.released),
			tips: new Map(entries.map((e) => [e.shard, e.tip])),
		};
	}

	async read(): Promise<ClaimsView> {
		return this.viewOf(await this.readEverything());
	}

	/** The repo holding a change's index. */
	private indexRemote(change: string) {
		return this.spread ? this.input.recordsRemote!(changeRepoOf(change, this.spread)) : this.input.remote();
	}

	/** The shards a change has claimed in below the registry, from its index (null: it has none). */
	private async indexed(change: string): Promise<string[] | null> {
		const [entry] = await readRefs(await this.indexRemote(change), [changeRef(this.input.repo, change)]);
		return entry ? ((entry.state as unknown as { shards?: string[] }).shards ?? []) : null;
	}

	/**
	 * The records that may hold a change's claim: the registry and the shards
	 * its index names (and `also`, the shards a caller wants besides). With no
	 * index, it has claimed only in the registry, unless its shards date from
	 * before changes were indexed: then every shard.
	 */
	private async changeEntries(change: string, also: () => string[] = () => []): Promise<Entry[]> {
		// Every records repo's credentials meanwhile, for the shards the index names.
		if (this.sharded) for (const remote of this.remotes()) remote.catch(() => undefined);
		const [index, root] = await Promise.all([this.sharded ? this.indexed(change) : Promise.resolve(undefined), this.readRoot()]);
		if (!this.sharded) return root;
		// Sharded since this store was made: the index too.
		const own = index === undefined ? await this.indexed(change) : index;
		if (own === null && !this.alwaysIndexed) return [...root, ...(await this.readAll())];
		return [...root, ...(await this.readShards([...(own ?? []), ...also()]))];
	}

	async readChange(change: string): Promise<ChangeView> {
		const view = this.viewOf(await this.changeEntries(change));
		return { claim: view.claims.find((c) => c.change === change), released: view.released.filter((r) => r.change === change) };
	}

	async readScope(change: string, files: string[]): Promise<ClaimsView> {
		// The change's own records, and every shard covering the files or above them.
		return this.viewOf(
			await this.changeEntries(change, () =>
				files.flatMap((file) => {
					const shard = shardOf(file, this.depth);
					return [...ancestorsOf(shard), shard];
				}),
			),
		);
	}

	/** Where a claim's paths are written: the registry, unsharded; else each path's shard, or, spread wide, the one shard holding them all. */
	private place(paths: string[]): Map<string, string[]> {
		if (!this.sharded) return new Map([[ROOT, paths]]);
		const groups = new Map<string, string[]>();
		for (const path of paths) {
			const shard = shardOf(path, this.depth);
			groups.set(shard, [...(groups.get(shard) ?? []), path]);
		}
		return groups.size > MAX_SPREAD ? new Map([[commonShard([...groups.keys()]), paths]]) : groups;
	}

	async claim(input: ClaimInput, stamper?: Stamper): Promise<ClaimOutcome> {
		const placed = this.place(input.paths);
		const shards = [...placed.keys()].sort();
		const below = shards.filter((s) => s !== ROOT);
		// The change's index first, so it always covers every shard the change holds below the registry.
		if (below.length)
			await appendRecord<{ shards: string[] }, "known">(
				new GitCasLog<{ shards: string[] }>(() => this.indexRemote(input.change), this.input.repo, changeRef(this.input.repo, input.change)),
				input.agent,
				() => ({ shards: [] }),
				(state) => (below.every((s) => state.shards.includes(s)) ? { refused: "known" } : { state: { shards: [...new Set([...state.shards, ...below])].sort() }, text: `${input.change} claims in ${below.join(", ")}` }),
			);
		const written: { shard: string; previous: string[] | null }[] = [];
		const backOut = async (reason: string) => {
			for (const { shard, previous } of written.reverse())
				await withdraw(this.logOf(shard), { change: input.change, agent: input.agent, keep: previous, reason }, stamper).catch(() => undefined);
		};

		for (const shard of shards) {
			const outcome = await claim(this.logOf(shard), { ...input, paths: placed.get(shard)! }, stamper);
			if (!outcome.ok) {
				await backOut(`part of the claim is held by ${outcome.conflicts[0]?.change}`);
				return outcome;
			}
			// Written in the registry after it was sharded: a claim above every shard, which must look below.
			if (shard === ROOT) this.learn(outcome.seen);
			written.push({ shard, previous: outcome.previous });
		}
		if (!this.sharded) return { ok: true };

		// Written: now look at the other levels.
		const conflicts = await this.othersOverlapping(input, placed, stamper);
		if (conflicts.length) {
			await backOut(`overlaps ${conflicts[0].change}'s claim`);
			return { ok: false, conflicts };
		}
		return { ok: true };
	}

	/**
	 * The claims at other levels overlapping a claim just written: in the
	 * shards above each part (the registry first), and below a part that
	 * covers more than its own shard (a wide path, a claim spread wide, or one
	 * in the registry). Stale ones in the way are released.
	 */
	private async othersOverlapping(input: ClaimInput, placed: Map<string, string[]>, stamper?: Stamper): Promise<Conflict[]> {
		const above = new Set<string>();
		const belowOf: string[] = [];
		for (const [shard, paths] of placed) {
			if (shard !== ROOT) for (const s of [ROOT, ...ancestorsOf(shard)]) above.add(s);
			if (shard === ROOT || paths.some((p) => isWide(p, this.depth) || shardOf(p, this.depth) !== shard)) belowOf.push(shard);
		}
		const everything = belowOf.includes(ROOT);
		const listed = everything ? [] : (await Promise.all(belowOf.map((s) => this.list(`${shardRef(this.input.repo, s)}%2F`)))).flat();
		const [root, shards] = await Promise.all([
			// The registry fresh: it's the level every claim checks.
			above.has(ROOT) ? this.input.root.read().then((head) => (head ? [{ shard: ROOT, tip: head.tip, state: head.commit.state }] : [])) : Promise.resolve([] as Entry[]),
			everything ? this.readAll() : this.readShards([...above, ...listed]),
		]);
		const live: Conflict[] = [];
		for (const entry of [...root, ...shards]) {
			// The paths written elsewhere: those written here were checked against it as they were written.
			const paths = [...placed].flatMap(([shard, p]) => (shard === entry.shard ? [] : p));
			for (const conflict of conflictsWith(entry.state, paths, input.change)) {
				const holder = entry.state.claims.find((c) => c.change === conflict.change)!;
				const stale = input.staleAfterMs !== undefined && (input.now ?? Date.now()) - Date.parse(holder.active) > input.staleAfterMs;
				if (stale) {
					const freed = await releaseStale(this.logOf(entry.shard), { change: conflict.change, agent: input.agent, staleAfterMs: input.staleAfterMs!, now: input.now }, stamper);
					if (freed.ok || /holds no claim/.test(freed.refused)) continue;
				}
				live.push(conflict);
			}
		}
		return live;
	}

	/** Where a change's claim is held now (each record holding it), and the claim as one. */
	private async holding(change: string) {
		const entries = (await this.changeEntries(change)).filter((e) => e.state.claims.some((c) => c.change === change));
		const own = mergeByChange(entries.flatMap((e) => e.state.claims.filter((c) => c.change === change)))[0];
		return own ? { own, shards: entries.map((e) => e.shard) } : null;
	}

	async release(input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper): Promise<ReleaseOutcome> {
		const held = await this.holding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		return this.eachShard(held.shards, (shard) => release(this.logOf(shard), input, stamper));
	}

	async releaseStale(input: { change: string; agent: string; staleAfterMs: number; now?: number }, stamper?: Stamper): Promise<ReleaseOutcome> {
		const held = await this.holding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		// Stale as a whole: by its latest activity in any record.
		const idle = (input.now ?? Date.now()) - Date.parse(held.own.active);
		if (idle <= input.staleAfterMs) return { ok: false, refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
		return this.eachShard(held.shards, (shard) => releaseStale(this.logOf(shard), input, stamper));
	}

	/**
	 * Release in each record: a few repos at a time, each one's records in
	 * turn. A record that no longer holds the claim is fine; the first other
	 * refusal is the outcome (the other repos' records are still released).
	 * Workers lets a request keep 6 connections open; more, and it cancels
	 * stalled ones, so RELEASE_REPOS_AT_ONCE stays under that.
	 */
	private async eachShard(shards: string[], step: (shard: string) => Promise<{ ok: true } | { ok: false; refused: string }>): Promise<ReleaseOutcome> {
		const byRepo = new Map<number, string[]>();
		for (const shard of shards) byRepo.set(this.repoOf(shard), [...(byRepo.get(this.repoOf(shard)) ?? []), shard]);
		const groups = [...byRepo.values()];
		let refused: ReleaseOutcome | null = null;
		const worker = async () => {
			for (let group = groups.shift(); group; group = groups.shift())
				for (const shard of group) {
					const outcome = await step(shard);
					if (!outcome.ok && !/holds no claim/.test(outcome.refused)) {
						refused ??= outcome;
						break;
					}
				}
		};
		await Promise.all(Array.from({ length: Math.min(RELEASE_REPOS_AT_ONCE, groups.length) }, worker));
		return refused ?? { ok: true };
	}

	/**
	 * What a merge cites as the claims it checked (its Blueprint-Claims
	 * trailer): unsharded, the registry's tip; sharded, `shard=tip` for the
	 * registry ("") and each shard its files and claim are in, and those above.
	 */
	cite(view: ClaimsView, files: string[], own?: ClaimRecord) {
		if (!this.sharded) return view.tips.get(ROOT) ?? "";
		const shards = new Set<string>([ROOT]);
		for (const path of [...files, ...(own?.paths ?? [])]) {
			const shard = shardOf(path, this.depth);
			for (const s of [...ancestorsOf(shard), shard]) shards.add(s);
		}
		return [...shards]
			.filter((s) => view.tips.has(s))
			.sort()
			.map((s) => `${encodeShard(s)}=${view.tips.get(s)}`)
			.join(" ");
	}
}

/** A change's records across shards as one claim: all its paths, its first claim, its latest activity. */
function mergeByChange(records: ClaimRecord[]): ClaimRecord[] {
	const byChange = new Map<string, ClaimRecord>();
	for (const record of records) {
		const seen = byChange.get(record.change);
		if (!seen) {
			const { stamp: _stamp, ...rest } = record;
			byChange.set(record.change, { ...rest, paths: [...record.paths] });
			continue;
		}
		seen.paths.push(...record.paths);
		if (record.since < seen.since) seen.since = record.since;
		if (record.active > seen.active) seen.active = record.active;
	}
	return [...byChange.values()].map((c) => ({ ...c, paths: [...new Set(c.paths)].sort() })).sort((a, b) => a.change.localeCompare(b.change));
}
