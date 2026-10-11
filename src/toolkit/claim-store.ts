import git from "isomorphic-git";
import { gitAuth, http } from "../git-http";
import type { CasLog } from "../record-log";
import { GitCasLog } from "../record-log";
import { isEmptyRepo, type Remote } from "../git";
import { RecordsRepos } from "./records-repos";
import { retryTransient } from "../retry";
import { readAllShards, readRefs } from "./record-refs";
import {
	activeClaims,
	type Abandoned,
	changeTaken,
	claim,
	conflictsWith,
	release,
	releaseStale,
	withdraw,
	type ClaimRecord,
	type Conflict,
	type Registry,
	type ReleaseRecord,
} from "./claims";
import { appendRecord } from "./records";
import {
	ancestorsOf,
	changeRef,
	changeRepoOf,
	decodeShard,
	encodeShard,
	isWide,
	recordsRepoOf,
	shardOf,
	shardRef,
	shardsPrefix,
} from "./shards";
import type { Stamper } from "./stamp";

// Where a repo's claims live: in its claims registry until load calls for more, then also in per-path shards
// below it (see shards.ts). Callers see the same view either way: the claims in force, one per change.

export interface ClaimsView {
	/** The claims in force, one per change, merging a change's records across shards. */
	claims: ClaimRecord[];
	/** Every release in the records read. */
	released: ReleaseRecord[];
	/** The tip read for each record, by shard ("" for the registry). A merge cites these. */
	tips: Map<string, string>;
}

export interface ClaimInput {
	change: string;
	agent: string;
	paths: string[];
	intent: string;
	/** Changes it depends on (see ClaimRecord.after). */
	after?: string[];
	/** The branch it merges whole (see ClaimRecord.source). */
	source?: string;
	/** A claim in the way idle this long is released as stale, if `abandoned` agrees. */
	staleAfterMs?: number;
	abandoned?: Abandoned;
	now?: number;
}

/** A refused claim lists its conflicts and any records the back-out couldn't undo, which still hold its paths. */
export type ClaimOutcome = { ok: true } | { ok: false; conflicts: Conflict[]; stillHeld?: string[] };
export type ReleaseOutcome = { ok: true } | { ok: false; refused: string };

/** A change, and the files it would merge. */
export type Scope = { change: string; files: string[] };

export interface ChangeView {
	claim?: ClaimRecord;
	/** The change's releases, oldest first. */
	released: ReleaseRecord[];
}

export interface ClaimStore {
	read(): Promise<ClaimsView>;
	/** One change's claim and releases, reading only the records that hold them where possible. */
	readChange(change: string): Promise<ChangeView>;
	/** Everything bearing on merging `files` for `change`: its own claim and any covering the files. */
	readScope(change: string, files: string[]): Promise<ClaimsView>;
	/** readScope for several changes at once, reading each record once for all of them. */
	readScopes(scopes: Scope[]): Promise<ClaimsView[]>;
	claim(input: ClaimInput, stamper?: Stamper): Promise<ClaimOutcome>;
	release(
		input: { change: string; agent: string; reason: string; mergedAs?: string },
		stamper?: Stamper,
	): Promise<ReleaseOutcome>;
	releaseStale(
		input: { change: string; agent: string; staleAfterMs: number; abandoned?: Abandoned; now?: number },
		stamper?: Stamper,
	): Promise<ReleaseOutcome>;
	/** The GitHive-Claims trailer for a merge of `files`, from the view its claims were checked in. */
	cite(view: ClaimsView, files: string[], own?: ClaimRecord): string;
}

export interface StoreInput {
	repo: string;
	/** The claims registry's state, which says whether and how deep claims are sharded. */
	registry: Registry | null | undefined;
	/** The claims registry's log, and its head if the caller has just read it. */
	root: CasLog<Registry>;
	rootHead?: Awaited<ReturnType<CasLog<Registry>["read"]>>;
	remote: () => Promise<Remote>;
	/** Credentials for a records repo, when shards are spread over records repos. */
	recordsRemote?: (k: number) => Promise<Remote>;
	/** A shard's log in the project repo, if the caller caches logs across calls. */
	log?: (ref: string) => CasLog<Registry> & Pick<GitCasLog<Registry>, "readAt">;
}

const RELEASE_REPOS_AT_ONCE = 4;
const BACK_OUT_TRIES = 3;

export function claimStore(input: StoreInput): ClaimStore {
	return new Claims(input);
}

// The registry, as the shard above every other.
const ROOT = "";

// A claim spanning more shards than this is written once, in the shard that holds them all.
const MAX_SPREAD = 4;

type Entry = { shard: string; tip: string; state: Registry };
type ChangeIndex = { shards: string[]; agent?: string };
type Written = { shard: string; previous: string[] | null };

// The shard containing all of `shards`, or ROOT if they share no first segment.
function commonShard(shards: string[]) {
	const split = shards.map((shard) => shard.split("/"));
	const [firstParts = []] = split;
	const common: string[] = [];
	for (const [index, part] of firstParts.entries()) {
		if (!split.every((parts) => parts[index] === part)) break;
		common.push(part);
	}
	return common.join("/");
}

// A repo's claims, in its registry and, once sharded, in per-path shards below it. A sharded claim is written to
// its paths' shards first, then checks the levels above and below. Each claim writes before it looks, so of two
// overlapping claims at different levels at least one sees the other.
class Claims implements ClaimStore {
	private readonly logs = new Map<string, CasLog<Registry> & Pick<GitCasLog<Registry>, "readAt">>();
	private depth: number;
	private recordsRepos: number;
	private alwaysIndexed: boolean;
	private known?: Awaited<ReturnType<CasLog<Registry>["read"]>>;
	private readonly repos: RecordsRepos;

	constructor(private readonly input: StoreInput) {
		this.repos = new RecordsRepos(input, () => this.recordsRepos);
		this.depth = input.registry?.shardDepth ?? 0;
		this.recordsRepos = input.registry?.recordsRepos ?? 0;
		this.alwaysIndexed = !!input.registry?.shardedAt;
		this.known = input.rootHead;
	}

	private get sharded() {
		return this.depth > 0;
	}

	// Sharding only ever turns on, so the first sharded state seen is final.
	private learn(state: Registry | null | undefined) {
		if (!state?.shardDepth || this.sharded) return;
		this.depth = state.shardDepth;
		this.recordsRepos = state.recordsRepos ?? 0;
		this.alwaysIndexed = !!state.shardedAt;
	}

	// -1 for the project repo (the registry, and shards when not spread), otherwise a records repo index.
	private repoOf(shard: string) {
		return shard !== ROOT && this.repos.spread ? recordsRepoOf(shard, this.repos.spread) : -1;
	}

	// Shards grouped by the repo holding them (see repoOf).
	private byRepo(shards: Iterable<string>) {
		return this.repos.group(shards, (shard) => this.repoOf(shard));
	}

	private logOf(shard: string) {
		if (shard === ROOT) return this.input.root;
		const ref = shardRef(this.input.repo, shard);
		let log = this.logs.get(ref);
		if (!log) {
			log =
				(!this.repos.spread && this.input.log?.(ref)) ||
				new GitCasLog<Registry>(() => this.repos.remote(this.repoOf(shard)), this.input.repo, ref);
			this.logs.set(ref, log);
		}
		return log;
	}

	// Uses the head the caller just read once, then reads the ref again.
	private async readRoot(): Promise<Entry[]> {
		const head = this.known !== undefined ? this.known : await this.input.root.read();
		this.known = undefined;
		this.learn(head?.commit.state);
		return head ? [{ shard: ROOT, tip: head.tip, state: head.commit.state }] : [];
	}

	// The shards whose refs start with `prefix`, with one listing per repo holding shards.
	private async list(prefix = shardsPrefix(this.input.repo)) {
		const base = shardsPrefix(this.input.repo);
		const listed = await Promise.all(
			this.repos.all().map(async (pending) => {
				const remote = await pending;
				const refs = await retryTransient(() =>
					git
						.listServerRefs({ http, url: remote.url, protocolVersion: 1, prefix, ...gitAuth(remote) })
						.catch((err) => (isEmptyRepo(err) ? [] : Promise.reject(err))),
				);
				return refs.filter((r) => r.ref.startsWith(prefix)).map((r) => decodeShard(r.ref.slice(base.length)));
			}),
		);
		return listed.flat();
	}

	private async readAll(): Promise<Entry[]> {
		const prefix = shardsPrefix(this.input.repo);
		const shards = (
			await Promise.all(this.repos.all().map(async (remote) => readAllShards<Registry>(await remote, prefix)))
		).flat();
		return shards.map(({ ref, tip, state }) => ({ shard: decodeShard(ref.slice(prefix.length)), tip, state }));
	}

	private async readShards(shards: string[]): Promise<Entry[]> {
		const byRepo = this.byRepo([...new Set(shards)].filter((shard) => shard !== ROOT));
		const read = await Promise.all(
			[...byRepo].map(async ([repoIndex, group]) =>
				readRefs<Registry>(
					await this.repos.remote(repoIndex),
					group.map((shard) => shardRef(this.input.repo, shard)),
				),
			),
		);
		const prefix = shardsPrefix(this.input.repo);
		return read
			.flat()
			.map((entry) => ({ shard: decodeShard(entry.ref.slice(prefix.length)), tip: entry.tip, state: entry.state }));
	}

	private async readEverything(): Promise<Entry[]> {
		const early = this.sharded ? this.readAll() : null;
		early?.catch(() => undefined);
		const root = await this.readRoot();
		if (early) return [...root, ...(await early)];
		// The registry may show sharding this store didn't know about, and then the shards are read too.
		return this.sharded ? [...root, ...(await this.readAll())] : root;
	}

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

	private indexRepoOf(change: string) {
		return this.repos.spread ? changeRepoOf(change, this.repos.spread) : -1;
	}

	private indexRemote(change: string) {
		return this.repos.remote(this.indexRepoOf(change));
	}

	// The shards each change has claimed in below the registry, from its index, or null if it has none. One read
	// per repo holding indexes.
	private async indexed(changes: string[]): Promise<Map<string, string[] | null>> {
		const unique = [...new Set(changes)];
		const byRepo = this.repos.group(unique, (change) => this.indexRepoOf(change));
		const read = await Promise.all(
			[...byRepo].map(async ([repoIndex, group]) =>
				readRefs<{ shards?: string[] }>(
					await this.repos.remote(repoIndex),
					group.map((change) => changeRef(this.input.repo, change)),
				),
			),
		);
		const byRef = new Map(read.flat().map((entry) => [entry.ref, entry.state.shards ?? []]));
		return new Map(unique.map((change) => [change, byRef.get(changeRef(this.input.repo, change)) ?? null]));
	}

	// The records that may hold each scope's change's claim, and the shards covering its files or above them. A
	// change with no index has claimed only in the registry, unless its shards predate indexing; then every shard
	// is read. Each record is read once for all the scopes.
	private async scopeEntries(scopes: Scope[]): Promise<Entry[][]> {
		// Fetch every records repo's credentials while the indexes are read.
		if (this.sharded) for (const remote of this.repos.all()) remote.catch(() => undefined);
		const changes = scopes.map((scope) => scope.change);
		const [early, root] = await Promise.all([
			this.sharded ? this.indexed(changes) : Promise.resolve(undefined),
			this.readRoot(),
		]);
		if (!this.sharded) return scopes.map(() => root);
		// Sharded since this store was made, so read the indexes now.
		const indexes = early ?? (await this.indexed(changes));
		const unindexed = (scope: Scope) => indexes.get(scope.change) === null && !this.alwaysIndexed;
		const wanted = scopes.map((scope) => new Set([...(indexes.get(scope.change) ?? []), ...this.covering(scope)]));
		const all = scopes.some(unindexed) ? await this.readAll() : undefined;
		const read = all ?? (await this.readShards(wanted.flatMap((shards) => [...shards])));
		return scopes.map((scope, index) => {
			if (all && unindexed(scope)) return [...root, ...all];
			return [...root, ...read.filter((entry) => wanted[index]!.has(entry.shard))];
		});
	}

	// The shards covering a scope's files, or above them.
	private covering(scope: Scope) {
		return scope.files.flatMap((file) => {
			const shard = shardOf(file, this.depth);
			return [...ancestorsOf(shard), shard];
		});
	}

	private async changeEntries(change: string): Promise<Entry[]> {
		const [entries] = await this.scopeEntries([{ change, files: [] }]);
		return entries ?? [];
	}

	async readChange(change: string): Promise<ChangeView> {
		const view = this.viewOf(await this.changeEntries(change));
		return {
			claim: view.claims.find((c) => c.change === change),
			released: view.released.filter((r) => r.change === change),
		};
	}

	async readScope(change: string, files: string[]): Promise<ClaimsView> {
		const [view] = await this.readScopes([{ change, files }]);
		return view!;
	}

	async readScopes(scopes: Scope[]): Promise<ClaimsView[]> {
		return (await this.scopeEntries(scopes)).map((entries) => this.viewOf(entries));
	}

	// Unsharded, a claim goes in the registry. Sharded, each path goes in its shard, or all of them in one common
	// shard if they are spread too wide.
	private place(paths: string[]): Map<string, string[]> {
		// A claim of no paths (a merge that changes no file) holds nothing, and goes in the registry.
		if (!this.sharded || !paths.length) return new Map([[ROOT, paths]]);
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
		const below = shards.filter((shard) => shard !== ROOT);
		if (below.length) await this.claimIndex(input, below, stamper);
		const written: Written[] = [];
		for (const shard of shards) {
			const outcome = await claim(this.logOf(shard), { ...input, paths: placed.get(shard)! }, stamper);
			if (!outcome.ok) {
				const reason = `part of the claim is held by ${outcome.conflicts[0]?.change}`;
				return { ...outcome, ...(await this.backOut(input, written, reason, stamper)) };
			}
			// Written in the registry after sharding, so it sits above every shard and must look below.
			if (shard === ROOT) this.learn(outcome.seen);
			written.push({ shard, previous: outcome.previous });
		}
		if (!this.sharded) return { ok: true };

		// Now that it's written, check the other levels.
		const conflicts = await this.othersOverlapping(input, placed, stamper);
		const [firstConflict] = conflicts;
		if (firstConflict) {
			const reason = `overlaps ${firstConflict.change}'s claim`;
			return { ok: false, conflicts, ...(await this.backOut(input, written, reason, stamper)) };
		}
		return { ok: true };
	}

	// Writes the change's index before its sharded claim, so the index always covers every shard the change holds.
	// It names the change's agent, so another agent's claim under the same name is refused.
	private async claimIndex(input: ClaimInput, below: string[], stamper?: Stamper) {
		// A change claimed in the registry before sharding belongs to its agent too. The caller's recent read is
		// enough here, since the check after writing reads the registry fresh.
		const root = this.known !== undefined ? this.known : await this.input.root.read();
		const held = root?.commit.state.claims.find((claim) => claim.change === input.change);
		if (held && held.agent !== input.agent) throw new Error(changeTaken(input.change, held.agent));
		await appendRecord<ChangeIndex, "known">(
			new GitCasLog<ChangeIndex>(
				() => this.indexRemote(input.change),
				this.input.repo,
				changeRef(this.input.repo, input.change),
			),
			input.agent,
			() => ({ shards: [] }),
			async (state) => {
				if (state.agent && state.agent !== input.agent) {
					await this.takeOver(input, state.agent, stamper);
					return {
						state: { shards: below, agent: input.agent },
						text: `${input.agent} takes over ${input.change} (released by ${state.agent}), in ${below.join(", ")}`,
					};
				}
				if (state.agent && below.every((shard) => state.shards.includes(shard))) return { refused: "known" };
				return {
					state: { shards: [...new Set([...state.shards, ...below])].sort(), agent: state.agent ?? input.agent },
					text: `${input.change} claims in ${below.join(", ")}`,
				};
			},
		);
	}

	// Another agent's name is on the change. Refuse while that agent holds a claim under it; once the claim is
	// released, the name and its paths are free again.
	private async takeOver(input: ClaimInput, owner: string, stamper?: Stamper) {
		const held = await this.holding(input.change);
		if (!held) return;
		// Still held and not abandoned, so the change is that agent's.
		if (!(await staleFor(input, held.own))) throw new Error(changeTaken(input.change, owner));
		// Abandoned: release it in every shard it holds, not only those this claim reaches.
		await this.releaseStale(
			{
				change: input.change,
				agent: input.agent,
				staleAfterMs: input.staleAfterMs!,
				...(input.now !== undefined ? { now: input.now } : {}),
			},
			stamper,
		);
	}

	// Undoes each written part, retrying a few times. A part left behind holds paths the agent is told it doesn't
	// have, so those are named in the refusal.
	private async backOut(input: ClaimInput, written: Written[], reason: string, stamper?: Stamper) {
		const stuck: string[] = [];
		for (const { shard, previous } of written.reverse()) {
			const withdrawn = () =>
				withdraw(this.logOf(shard), { change: input.change, agent: input.agent, keep: previous, reason }, stamper);
			try {
				await retryTransient(withdrawn, {
					maxAttempts: BACK_OUT_TRIES,
					retryable: () => true,
					delayMs: (n) => n * 500,
				});
			} catch (err) {
				console.error(`backing ${input.change} out of ${shard} failed`, String(err));
				stuck.push(shard);
			}
		}
		return stuck.length ? { stillHeld: stuck } : {};
	}

	// Claims at other levels overlapping a claim just written: in the shards above each part, and below any part
	// wider than its own shard. Stale claims in the way are released.
	private async othersOverlapping(
		input: ClaimInput,
		placed: Map<string, string[]>,
		stamper?: Stamper,
	): Promise<Conflict[]> {
		const above = new Set<string>();
		const belowOf: string[] = [];
		for (const [shard, paths] of placed) {
			if (shard !== ROOT) for (const ancestor of [ROOT, ...ancestorsOf(shard)]) above.add(ancestor);
			const reachesBelow = paths.some((path) => isWide(path, this.depth) || shardOf(path, this.depth) !== shard);
			if (shard === ROOT || reachesBelow) belowOf.push(shard);
		}
		const everything = belowOf.includes(ROOT);
		const listed = everything
			? []
			: (await Promise.all(belowOf.map((shard) => this.list(`${shardRef(this.input.repo, shard)}%2F`)))).flat();
		const [root, shards] = await Promise.all([
			// Read the registry fresh, since every claim checks it.
			above.has(ROOT) ? this.readRootFresh() : Promise.resolve([] as Entry[]),
			everything ? this.readAll() : this.readShards([...above, ...listed]),
		]);
		const live: Conflict[] = [];
		for (const entry of [...root, ...shards]) {
			// Only paths written elsewhere; those written here were checked as they were written.
			const paths = [...placed].flatMap(([shard, written]) => (shard === entry.shard ? [] : written));
			for (const conflict of conflictsWith(entry.state, paths, input.change)) {
				const holder = entry.state.claims.find((held) => held.change === conflict.change)!;
				if (await staleFor(input, holder)) {
					const freed = await releaseStale(
						this.logOf(entry.shard),
						{ change: conflict.change, agent: input.agent, staleAfterMs: input.staleAfterMs!, now: input.now },
						stamper,
					);
					if (freed.ok || /holds no claim/.test(freed.refused)) continue;
				}
				live.push(conflict);
			}
		}
		return live;
	}

	private async readRootFresh(): Promise<Entry[]> {
		const head = await (this.input.root.readFresh?.() ?? this.input.root.read());
		return head ? [{ shard: ROOT, tip: head.tip, state: head.commit.state }] : [];
	}

	// Every record holding a change's claim, and the claim merged into one.
	private async holding(change: string) {
		const ownRecords = (entry: Entry) => entry.state.claims.filter((held) => held.change === change);
		const entries = (await this.changeEntries(change)).filter((entry) => ownRecords(entry).length);
		const own = mergeByChange(entries.flatMap(ownRecords))[0];
		return own ? { own, shards: entries.map((entry) => entry.shard) } : null;
	}

	async release(
		input: { change: string; agent: string; reason: string; mergedAs?: string },
		stamper?: Stamper,
	): Promise<ReleaseOutcome> {
		const held = await this.holding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		return this.eachShard(held.shards, (shard) => release(this.logOf(shard), input, stamper));
	}

	async releaseStale(
		input: { change: string; agent: string; staleAfterMs: number; abandoned?: Abandoned; now?: number },
		stamper?: Stamper,
	): Promise<ReleaseOutcome> {
		const held = await this.holding(input.change);
		if (!held) return { ok: false, refused: `${input.change} holds no claim` };
		// Judge staleness once for the whole claim, by its latest activity in any record.
		const idle = (input.now ?? Date.now()) - Date.parse(held.own.active);
		if (idle <= input.staleAfterMs)
			return {
				ok: false,
				refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale`,
			};
		const turn = input.abandoned ? await input.abandoned(held.own) : undefined;
		if (turn && !turn.abandoned) return { ok: false, refused: `${input.change} isn't abandoned: it ${turn.why}` };
		const { abandoned: _abandoned, ...rest } = input;
		return this.eachShard(held.shards, (shard) => releaseStale(this.logOf(shard), rest, stamper));
	}

	// Releases in each record, a few repos at a time. A record that no longer holds the claim is fine, and the first
	// other refusal is returned. Workers cancels stalled connections past 6 per request, so stay under that.
	private async eachShard(
		shards: string[],
		step: (shard: string) => Promise<{ ok: true } | { ok: false; refused: string }>,
	): Promise<ReleaseOutcome> {
		const groups = [...this.byRepo(shards).values()];
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

	// Unsharded: the registry's tip. Sharded: `shard=tip` for the registry and each shard holding the files or
	// claim, plus their ancestors.
	cite(view: ClaimsView, files: string[], own?: ClaimRecord) {
		if (!this.sharded) return view.tips.get(ROOT) ?? "";
		const shards = new Set<string>([ROOT]);
		for (const path of [...files, ...(own?.paths ?? [])]) {
			const shard = shardOf(path, this.depth);
			for (const covering of [...ancestorsOf(shard), shard]) shards.add(covering);
		}
		return [...shards]
			.filter((shard) => view.tips.has(shard))
			.sort()
			.map((shard) => `${encodeShard(shard)}=${view.tips.get(shard)}`)
			.join(" ");
	}
}

// Whether `held` is stale for this claim: idle past the floor and, when the caller can tell, abandoned.
async function staleFor(input: ClaimInput, held: ClaimRecord): Promise<boolean> {
	return (
		input.staleAfterMs !== undefined &&
		(input.now ?? Date.now()) - Date.parse(held.active) > input.staleAfterMs &&
		(!input.abandoned || (await input.abandoned(held)).abandoned)
	);
}

// A change's records across shards as one claim: all its paths, its first claim and its latest activity.
function mergeByChange(records: ClaimRecord[]): ClaimRecord[] {
	const byChange = new Map<string, ClaimRecord>();
	for (const record of records) {
		const merged = byChange.get(record.change);
		if (!merged) {
			const { stamp: _stamp, ...rest } = record;
			byChange.set(record.change, { ...rest, paths: [...record.paths] });
			continue;
		}
		merged.paths.push(...record.paths);
		if (record.after) merged.after = [...new Set([...(merged.after ?? []), ...record.after])];
		if (record.since < merged.since) merged.since = record.since;
		if (record.active > merged.active) merged.active = record.active;
	}
	return [...byChange.values()]
		.map((merged) => ({ ...merged, paths: [...new Set(merged.paths)].sort() }))
		.sort((a, b) => a.change.localeCompare(b.change));
}
