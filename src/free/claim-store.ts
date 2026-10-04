import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CasLog } from "../election";
import { GitCasLog } from "../election-git";
import { isEmptyRepo, type Remote } from "../git";
import { fetchCommits } from "../git-fetch";
import { retryTransient } from "../retry";
import { activeClaims, claim, conflictsWith, release, releaseStale, withdraw, type ClaimRecord, type Conflict, type Registry, type ReleaseRecord } from "./claims";
import { ancestorsOf, decodeShard, encodeShard, isWide, recordsRepoOf, shardOf, shardRef, shardsPrefix } from "./shards";
import type { Stamper } from "./stamp";

// Where a repo's claims are kept: all in its claims registry (repos started
// before sharding), or split by path into shards (see shards.ts). Callers see
// the same thing either way: the claims in force, one per change.

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

export interface ClaimStore {
	read(): Promise<ClaimsView>;
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
const decoder = new TextDecoder();

/**
 * Every shard under `prefix`, at its tip: one listing, then one fetch for all
 * the shards whose tips aren't known yet. Brief server failures are retried.
 */
async function readAllShards(remote: Remote, prefix: string): Promise<{ ref: string; tip: string; state: Registry }[]> {
	const onAuth = () => ({ username: "x", password: remote.token.split("?expires=")[0] });
	for (let attempt = 1; ; attempt++) {
		const listed = (await retryTransient(() => git.listServerRefs({ http, url: remote.url, prefix, onAuth }).catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))))).filter((r) => r.ref.startsWith(prefix));
		const missing = [...new Set(listed.map((r) => r.oid).filter((oid) => !shardStates.has(oid)))];
		try {
			if (missing.length) {
				const { fs, dir } = await retryTransient(() => fetchCommits(remote, missing));
				for (const oid of missing) shardStates.set(oid, JSON.parse(decoder.decode((await git.readBlob({ fs, dir, oid, filepath: "state.json" })).blob)) as Registry);
			}
		} catch (err) {
			// A shard moved between the listing and the fetch: its old tip is no longer served. List again.
			if (attempt < 3 && /not our ref|fetch refused/i.test(String(err))) continue;
			throw err;
		}
		return listed.map((r) => ({ ref: r.ref, tip: r.oid, state: shardStates.get(r.oid)! }));
	}
}

export function claimStore(input: StoreInput): ClaimStore {
	return input.registry?.shardDepth ? new ShardedClaims(input, input.registry.shardDepth) : new RegistryClaims(input.root, input.rootHead);
}

const asRelease = (outcome: { ok: true } | { ok: false; refused: string }): ReleaseOutcome => (outcome.ok ? { ok: true } : outcome);

/** All claims in the registry itself. */
class RegistryClaims implements ClaimStore {
	constructor(
		private readonly root: CasLog<Registry>,
		private known?: Awaited<ReturnType<CasLog<Registry>["read"]>>,
	) {}

	async read(): Promise<ClaimsView> {
		// The head the caller just read, once; after that, the ref again.
		const head = this.known !== undefined ? this.known : await this.root.read();
		this.known = undefined;
		return { claims: activeClaims(head?.commit.state), released: head?.commit.state.released ?? [], tips: new Map(head ? [["", head.tip]] : []) };
	}

	async claim(input: ClaimInput, stamper?: Stamper): Promise<ClaimOutcome> {
		const outcome = await claim(this.root, input, stamper);
		return outcome.ok ? { ok: true } : outcome;
	}

	async release(input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper) {
		return asRelease(await release(this.root, input, stamper));
	}

	async releaseStale(input: { change: string; agent: string; staleAfterMs: number; now?: number }, stamper?: Stamper) {
		return asRelease(await releaseStale(this.root, input, stamper));
	}

	cite(view: ClaimsView) {
		return view.tips.get("") ?? "";
	}
}

/**
 * Claims split into per-path shards, each its own ref. A claim is written to
 * each shard its paths are in, in order; then, written, it checks the shards
 * above it (and, if wide, below it) for an overlap, and backs out of all of
 * them if it finds one. Of two overlapping claims at different levels, at
 * least one sees the other, since each writes before it looks.
 */
class ShardedClaims implements ClaimStore {
	private readonly logs = new Map<string, CasLog<Registry> & Pick<GitCasLog<Registry>, "readAt">>();

	constructor(
		private readonly input: StoreInput,
		private readonly depth: number,
	) {}

	/** How many records repos the shards are spread over (0: they're in the project repo). */
	private get spread() {
		return this.input.recordsRemote ? (this.input.registry?.recordsRepos ?? 0) : 0;
	}

	/** Where a shard's ref lives: its records repo, or the project repo. */
	private remoteOf(shard: string) {
		return this.spread ? () => this.input.recordsRemote!(recordsRepoOf(shard, this.spread)) : this.input.remote;
	}

	/** Every repo that holds shards. */
	private remotes() {
		return this.spread ? Array.from({ length: this.spread }, (_, k) => this.input.recordsRemote!(k)) : [this.input.remote()];
	}

	private logOf(shard: string) {
		const ref = shardRef(this.input.repo, shard);
		let log = this.logs.get(ref);
		if (!log) this.logs.set(ref, (log = (!this.spread && this.input.log?.(ref)) || new GitCasLog<Registry>(this.remoteOf(shard), this.input.repo, ref)));
		return log;
	}

	/** The shards whose refs start with `prefix`, with their tips: one listing per repo holding shards. */
	private async list(prefix = shardsPrefix(this.input.repo)) {
		const base = shardsPrefix(this.input.repo);
		const listed = await Promise.all(
			this.remotes().map(async (pending) => {
				const remote = await pending;
				const refs = await retryTransient(() =>
					git
						.listServerRefs({ http, url: remote.url, prefix, onAuth: () => ({ username: "x", password: remote.token.split("?expires=")[0] }) })
						.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))),
				);
				return refs.filter((r) => r.ref.startsWith(prefix)).map((r) => ({ shard: decodeShard(r.ref.slice(base.length)), tip: r.oid }));
			}),
		);
		return listed.flat();
	}

	async read(): Promise<ClaimsView> {
		const prefix = shardsPrefix(this.input.repo);
		const shards = (await Promise.all(this.remotes().map(async (remote) => readAllShards(await remote, prefix)))).flat();
		const tips = new Map<string, string>();
		const records: ClaimRecord[] = [];
		const released: ReleaseRecord[] = [];
		for (const { ref, tip, state } of shards) {
			tips.set(decodeShard(ref.slice(prefix.length)), tip);
			records.push(...state.claims);
			released.push(...state.released);
		}
		return { claims: mergeByChange(records), released, tips };
	}

	async claim(input: ClaimInput, stamper?: Stamper): Promise<ClaimOutcome> {
		const groups = new Map<string, string[]>();
		for (const path of input.paths) {
			const shard = shardOf(path, this.depth);
			groups.set(shard, [...(groups.get(shard) ?? []), path]);
		}
		const shards = [...groups.keys()].sort();
		const written: { shard: string; previous: string[] | null }[] = [];
		const backOut = async (reason: string) => {
			for (const { shard, previous } of written.reverse())
				await withdraw(this.logOf(shard), { change: input.change, agent: input.agent, keep: previous, reason }, stamper).catch(() => undefined);
		};

		for (const shard of shards) {
			const outcome = await claim(this.logOf(shard), { ...input, paths: groups.get(shard)! }, stamper);
			if (!outcome.ok) {
				await backOut(`part of the claim is held by ${outcome.conflicts[0]?.change}`);
				return outcome;
			}
			written.push({ shard, previous: outcome.previous });
		}

		// Written: now look at the other levels.
		for (const shard of shards) {
			const paths = groups.get(shard)!;
			const others: { shard: string; tip?: string }[] = ancestorsOf(shard).map((s) => ({ shard: s }));
			if (paths.some((p) => isWide(p, this.depth))) others.push(...(await this.list(`${shardRef(this.input.repo, shard)}%2F`)));
			for (const other of others) {
				const log = this.logOf(other.shard);
				const head = await retryTransient(() => (other.tip ? log.readAt(other.tip) : log.read()));
				const live: Conflict[] = [];
				for (const conflict of conflictsWith(head?.commit.state, paths, input.change)) {
					const holder = head!.commit.state.claims.find((c) => c.change === conflict.change)!;
					const stale = input.staleAfterMs !== undefined && (input.now ?? Date.now()) - Date.parse(holder.active) > input.staleAfterMs;
					if (stale) {
						const freed = await releaseStale(log, { change: conflict.change, agent: input.agent, staleAfterMs: input.staleAfterMs!, now: input.now }, stamper);
						if (freed.ok || /holds no claim/.test(freed.refused)) continue;
					}
					live.push(conflict);
				}
				if (live.length) {
					await backOut(`overlaps ${live[0].change}'s claim`);
					return { ok: false, conflicts: live };
				}
			}
		}
		return { ok: true };
	}

	/** The shards a change's claim is in, from a fresh read. */
	private async shardsHolding(change: string) {
		const own = (await this.read()).claims.find((c) => c.change === change);
		return own ? { own, shards: [...new Set(own.paths.map((p) => shardOf(p, this.depth)))] } : null;
	}

	async release(input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper): Promise<ReleaseOutcome> {
		const held = await this.shardsHolding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		for (const shard of held.shards) {
			const outcome = await release(this.logOf(shard), input, stamper);
			if (!outcome.ok && !/holds no claim/.test(outcome.refused)) return outcome;
		}
		return { ok: true };
	}

	async releaseStale(input: { change: string; agent: string; staleAfterMs: number; now?: number }, stamper?: Stamper): Promise<ReleaseOutcome> {
		const held = await this.shardsHolding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		// Stale as a whole: by its latest activity in any shard.
		const idle = (input.now ?? Date.now()) - Date.parse(held.own.active);
		if (idle <= input.staleAfterMs) return { ok: false, refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
		for (const shard of held.shards) {
			const outcome = await releaseStale(this.logOf(shard), input, stamper);
			if (!outcome.ok && !/holds no claim/.test(outcome.refused)) return outcome;
		}
		return { ok: true };
	}

	cite(view: ClaimsView, files: string[], own?: ClaimRecord) {
		const shards = new Set<string>();
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
