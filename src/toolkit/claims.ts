import type { CasLog } from "../record-log";
import { entriesOverlap } from "../claim-paths";
import { appendRecord } from "./records";
import { scopedInto } from "./branch-scope";
import type { BranchRule } from "./branch-rules";
import { type Stamper, stampPayload } from "./stamp";
import type { ReviewPolicy } from "./votes";

// Claims (see docs/design.md). The registry is an
// append-only log in Git. An agent claims by reading the tip, checking for
// itself that no active claim overlaps its paths, and appending on that tip.
// The append is compare-and-swap, so of two overlapping claims made at once
// only one lands; the other reads again and finds the conflict. Nothing else
// decides: an agent could skip the check, and the audit would show it.

export interface ClaimRecord {
	change: string;
	agent: string;
	paths: string[];
	intent: string;
	since: string;
	/** Its holder's last claim or extension: a claim idle long enough may be released by anyone. */
	active: string;
	/** Who made it, as Access verified them, and GitHive's stamp over the record (written through the toolkit). */
	by?: string;
	stamp?: string;
	/** The branch its change lands on, when not the project's: set on claims as the tools give them out, never in the records (see branch-scope.ts). */
	into?: string;
	/** Changes it depends on: it merges only once each has merged into the branch it lands on. */
	after?: string[];
	/** For a change that merges a whole branch into the one it lands on: that branch (its tip is the change's head). */
	source?: string;
}

/** A released claim: who released it, after which merge (if it merged), and whether it was released as stale. */
export interface ReleaseRecord {
	change: string;
	agent: string;
	by: string;
	at: string;
	reason: string;
	mergedAs?: string;
	/** The branch it merged into, when not the project's (for changes that wait on it, see `after`). */
	into?: string;
	stale?: boolean;
	/** The holder's last activity, for the audit to check a stale release against. */
	lastActive: string;
	/** Who released it, as Access verified them, and GitHive's stamp (written through the toolkit). */
	verifiedBy?: string;
	stamp?: string;
}

/** A branch changes land on, besides the project's: made by a claim into it (`from` a branch), or adopted as it was. */
export interface BranchRecord {
	/** Its commit when GitHive first had a change land on it: made there from `from`, or found there. */
	base: string;
	/** The branch it was made from; absent for a branch that existed before GitHive. */
	from?: string;
	at: string;
	/** The agent whose claim made or adopted it. */
	agent: string;
	by?: string;
	stamp?: string;
}

/** The registry's state: the claims in force, and every release so far. */
export interface Registry {
	claims: ClaimRecord[];
	released: ReleaseRecord[];
	/** The project's branch: its default branch when GitHive started on it (main, master, ...). Absent on older registries: main. */
	branch?: string;
	/** The branch's commit when GitHive started on it: the audit reads the branch after it. */
	baseline?: string;
	/**
	 * The other branches changes land on, by name (see branch-scope.ts): where
	 * each started, for the audit to read it after, as `baseline` for the
	 * project's branch.
	 */
	branches?: Record<string, BranchRecord>;
	/** What the checks skip: a change touching only these runs none (see check-scope.ts). Absent: the defaults; []: never skip. */
	skipChecks?: string[];
	/** Settings for other branches, by pattern, the first matching (see branch-rules.ts): absent, every branch has the repo's. */
	branchRules?: BranchRule<ReviewPolicy>[];
	/** How many approvals a merge needs, and which roles veto. */
	policy?: ReviewPolicy;
	/** The project's checks, run on the branch plus a change before it merges. */
	verify?: string[];
	/** GitHive's public key, to check the stamps on records and merges with. */
	stampKey?: string;
	/**
	 * Claims are split into per-path shards this many segments deep (see
	 * shards.ts); absent, they're all here. Once sharded, this registry is the
	 * shard above every other: the claims made here before stay here.
	 */
	shardDepth?: number;
	/** The shards are spread over this many records repos (absent: they're in the project repo). */
	recordsRepos?: number;
	/** Shard when the load calls for it (see shardingReason), this deep and over this many records repos. */
	autoShard?: { depth: number; recordsRepos: number };
	/** When the claims were sharded, and why. Every claim outside this registry since has an index (see shards.ts). */
	shardedAt?: string;
	shardedBecause?: string;
	/** Registered agent names, each bound to one secret key. */
	agents?: Record<string, AgentRecord>;
}

/** An agent's registered name: who registered it, and a hash of its key (never the key). */
export interface AgentRecord {
	agent: string;
	keyHash: string;
	at: string;
	by?: string;
	stamp?: string;
}

export interface Conflict {
	path: string;
	held: string;
	change: string;
	agent: string;
	intent: string;
}

const empty = (): Registry => ({ claims: [], released: [] });

/**
 * Start GitHive on a repo: the registry's first entry records its
 * branch, the branch's baseline and the review policy, and how claims are kept:
 * sharded now (`shardDepth`), when the load calls for it (`autoShard`), or
 * all here. Harmless to repeat.
 */
export async function startRepo(log: CasLog<Registry>, input: { baseline: string; branch?: string; policy: ReviewPolicy; verify?: string[]; stampKey?: string; shardDepth?: number; recordsRepos?: number; autoShard?: Registry["autoShard"] }) {
	const outcome = await appendRecord<Registry, "started">(log, "githive", empty, (state) => {
		if (state.baseline) return { refused: "started" };
		const sharding: Partial<Registry> = input.shardDepth
			? { shardDepth: input.shardDepth, ...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}), shardedAt: new Date().toISOString(), shardedBecause: "asked for at the start" }
			: input.autoShard
				? { autoShard: input.autoShard }
				: {};
		return { state: { ...state, baseline: input.baseline, ...(input.branch ? { branch: input.branch } : {}), policy: input.policy, verify: input.verify ?? [], stampKey: input.stampKey, ...sharding }, text: `GitHive starts at ${input.baseline}${input.branch ? ` on ${input.branch}` : ""}` };
	});
	return { started: outcome.ok };
}

/**
 * Change a started repo's review policy or checks; what's left out stays. The
 * registry's history keeps every version, and the audit holds each merge to
 * the settings in the registry state it cites.
 */
export async function changeSettings(log: CasLog<Registry>, input: { policy?: ReviewPolicy; verify?: string[]; branchRules?: BranchRule<ReviewPolicy>[]; skipChecks?: string[]; by?: string }) {
	const outcome = await appendRecord<Registry, "not started" | "unchanged">(log, "githive", empty, (state) => {
		if (!state.baseline) return { refused: "not started" };
		const policy = input.policy && JSON.stringify(input.policy) !== JSON.stringify(state.policy) ? input.policy : undefined;
		const verify = input.verify && JSON.stringify(input.verify) !== JSON.stringify(state.verify ?? []) ? input.verify : undefined;
		const rules = input.branchRules && JSON.stringify(input.branchRules) !== JSON.stringify(state.branchRules ?? []) ? input.branchRules : undefined;
		const skip = input.skipChecks && JSON.stringify(input.skipChecks) !== JSON.stringify(state.skipChecks) ? input.skipChecks : undefined;
		if (!policy && !verify && !rules && !skip) return { refused: "unchanged" };
		const next: Registry = { ...state, ...(policy ? { policy } : {}), ...(verify ? { verify } : {}), ...(rules ? { branchRules: rules } : {}), ...(skip ? { skipChecks: skip } : {}) };
		const what = [policy && "the review policy", verify && `the checks (${verify.join("; ") || "none"})`, rules && `the branch rules (${rules.map((r) => r.pattern).join(", ") || "none"})`, skip && `what the checks skip (${skip.join(", ") || "nothing"})`].filter(Boolean).join(" and ");
		return { state: next, text: `Settings: ${what} changed${input.by ? ` by ${input.by}` : ""}` };
	});
	return outcome.ok ? { changed: true as const } : { changed: false as const, refused: outcome.refused };
}

/**
 * When an unsharded registry should shard, from the load it records: as many
 * agents holding claims as one record serves well, or as many writes a minute.
 * Measured on Artifacts (see docs/design.md): one record takes about
 * 35 writes a minute; with 8 agents claiming at once, sharded claims land first.
 */
export const SHARD_WHEN = { agents: 8, writesPerMinute: 15, windowMs: 5 * 60_000 };

/** Why `agent`'s claim should shard the registry first, or null if it needn't (or can't: sharded, or not on demand). */
export function shardingReason(state: Registry | null | undefined, agent: string, now = Date.now()): string | null {
	if (!state?.autoShard || state.shardDepth) return null;
	const agents = new Set([...state.claims.map((c) => c.agent), agent]);
	if (agents.size >= SHARD_WHEN.agents) return `${agents.size} agents hold claims`;
	// Claims made or extended, and releases, in the window: each was a write.
	const since = now - SHARD_WHEN.windowMs;
	const writes = state.claims.filter((c) => Date.parse(c.active) >= since).length + state.released.filter((r) => Date.parse(r.at) >= since).length;
	const perMinute = writes / (SHARD_WHEN.windowMs / 60_000);
	if (perMinute > SHARD_WHEN.writesPerMinute) return `${Math.round(perMinute)} claim writes a minute`;
	return null;
}

/** Shard the claims from here on (once: refused if they are). The claims held now stay in the registry, above every shard. */
export function shardClaims(log: CasLog<Registry>, input: { depth: number; recordsRepos: number; reason: string }) {
	return appendRecord<Registry, "sharded">(log, "githive", empty, (state) =>
		state.shardDepth
			? { refused: "sharded" }
			: {
					state: { ...state, shardDepth: input.depth, ...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}), shardedAt: new Date().toISOString(), shardedBecause: input.reason },
					text: `Claims are sharded from here on, ${input.depth} segments deep: ${input.reason}`,
				},
	);
}

export const activeClaims = (state: Registry | null | undefined) => state?.claims ?? [];

/** Paths in `paths` that a claim other than `change`'s holds. */
export function conflictsWith(state: Registry | null | undefined, paths: string[], change: string): Conflict[] {
	const conflicts: Conflict[] = [];
	for (const other of activeClaims(state)) {
		if (other.change === change) continue;
		for (const path of paths)
			for (const held of other.paths) if (entriesOverlap(path, held)) conflicts.push({ path, held, change: other.change, agent: other.agent, intent: other.intent });
	}
	return conflicts;
}

/** Why an agent can't claim under a change name another agent holds. */
export const changeTaken = (change: string, agent: string) => `[409] ${change} is ${agent}'s change: claim under a change name of your own`;

/** A record with who wrote it and GitHive's stamp over it, when written through the toolkit (`stamper`). */
async function stamped<T extends object>(kind: string, record: T, stamper: Stamper | undefined, byField: "by" | "verifiedBy" = "by"): Promise<T> {
	if (!stamper) return record;
	const withBy = { ...record, [byField]: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload(kind, withBy)) };
}

/**
 * Claim `paths` for a change, if no other change's claim overlaps them; claiming
 * again extends the change's claim (and counts as activity). With `staleAfterMs`,
 * a claim in the way that has been idle that long is released as stale in the
 * same record, so an abandoned claim frees itself when someone needs its paths.
 */
export async function claim(log: CasLog<Registry>, input: { change: string; agent: string; paths: string[]; intent: string; after?: string[]; source?: string; staleAfterMs?: number; abandoned?: Abandoned; now?: number }, stamper?: Stamper) {
	const { staleAfterMs, abandoned, now: at, ...wanted } = input;
	/** The change's paths here before this claim (null: it had none), for a claim that must back out. */
	let previous: string[] | null = null;
	/** The state the claim was written onto: whether the registry was sharded by then. */
	let seen: Registry | undefined;
	const outcome = await appendRecord<Registry, Conflict[]>(log, wanted.agent, empty, async (state) => {
		seen = state;
		const time = at ?? Date.now();
		const conflicts = conflictsWith(state, wanted.paths, wanted.change);
		// Stale: idle past the floor, and (when the caller can tell) abandoned on its agent's own turn.
		// The change's own name under another agent counts too: an abandoned change can be taken over.
		const sameName = state.claims.find((c) => c.change === wanted.change && c.agent !== wanted.agent);
		const stale = new Set<string>();
		for (const change of new Set([...conflicts.map((c) => c.change), ...(sameName ? [sameName.change] : [])])) {
			const held = state.claims.find((c) => c.change === change)!;
			if (staleAfterMs !== undefined && time - Date.parse(held.active) > staleAfterMs && (!abandoned || (await abandoned(held)).abandoned)) stale.add(change);
		}
		const blocking = conflicts.filter((c) => !stale.has(c.change));
		if (blocking.length) return { refused: blocking };
		const now = new Date(time).toISOString();
		// Stale claims in the way: released, each with its own stamped release record.
		const freedClaims = state.claims.filter((c) => stale.has(c.change));
		const releases: ReleaseRecord[] = [];
		for (const held of freedClaims)
			releases.push(await stamped("release", { change: held.change, agent: held.agent, by: wanted.agent, at: now, reason: "stale", stale: true, lastActive: held.active } as ReleaseRecord, stamper, "verifiedBy"));
		const remaining = state.claims.filter((c) => !freedClaims.includes(c));
		const existing = remaining.find((c) => c.change === wanted.change);
		// A change is its agent's: another agent claiming under its name would extend someone else's claim.
		if (existing && existing.agent !== wanted.agent) throw new Error(changeTaken(wanted.change, existing.agent));
		previous = existing ? [...existing.paths] : null;
		const { by: _by, stamp: _stamp, ...base } = existing ?? ({} as Partial<ClaimRecord>);
		const record = await stamped(
			"claim",
			existing
				? { ...(base as ClaimRecord), paths: [...existing.paths, ...wanted.paths.filter((p) => !existing.paths.includes(p))], active: now, ...(existing.after || wanted.after ? { after: [...new Set([...(existing.after ?? []), ...(wanted.after ?? [])])] } : {}), ...(wanted.source ? { source: wanted.source } : {}) }
				: { ...wanted, since: now, active: now },
			stamper,
		);
		const claims = existing ? remaining.map((c) => (c.change === wanted.change ? record : c)) : [...remaining, record];
		const freed = freedClaims.length ? ` (releasing stale ${freedClaims.map((c) => c.change).join(", ")})` : "";
		return { state: { ...state, claims, released: [...state.released, ...releases] }, text: `${wanted.agent} claims ${wanted.paths.join(", ")} for ${wanted.change}: ${wanted.intent}${freed}` };
	});
	return outcome.ok ? { ...outcome, previous, seen } : { ok: false as const, conflicts: outcome.refused };
}

/**
 * Back a claim out: set the change's paths back to `keep`, or, with null,
 * release it ("withdrawn"). For a claim that turned out to overlap another
 * once written (see sharded claims).
 */
export function withdraw(log: CasLog<Registry>, input: { change: string; agent: string; keep: string[] | null; reason: string }, stamper?: Stamper) {
	if (input.keep === null) return release(log, { change: input.change, agent: input.agent, reason: input.reason }, stamper);
	const keep = input.keep;
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const { by: _by, stamp: _stamp, ...base } = held;
		const record = await stamped("claim", { ...base, paths: keep }, stamper);
		return { state: { ...state, claims: state.claims.map((c) => (c.change === input.change ? record : c)) }, text: `${input.agent} withdraws ${input.change}'s claim to ${keep.join(", ")}: ${input.reason}` };
	});
}

/** Release a change's claim: its holder's, after it merged (say which merge) or was given up. */
export function release(log: CasLog<Registry>, input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper) {
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const into = input.mergedAs ? scopedInto(held.paths) : undefined;
		const record: ReleaseRecord = { change: input.change, agent: held.agent, by: input.agent, at: new Date().toISOString(), reason: input.reason, lastActive: held.active, ...(input.mergedAs ? { mergedAs: input.mergedAs } : {}), ...(into ? { into } : {}) };
		return {
			state: {
				...state,
				claims: state.claims.filter((c) => c.change !== input.change),
				released: [...state.released, await stamped("release", record, stamper, "verifiedBy")],
			},
			text: `${input.agent} releases ${input.change}${input.mergedAs ? ` after merging ${input.mergedAs}` : ""}: ${input.reason}`,
		};
	});
}

/**
 * Whether a claim is abandoned on its agent's own turn, and if not, what its
 * change waits on (see staleness.ts). The caller knows the change's head, votes
 * and whether it's being checked to land; the records here don't.
 */
export type Abandoned = (claim: ClaimRecord) => Promise<{ abandoned: boolean; why: string }>;

/** Release another agent's claim, if it has been idle longer than `staleAfterMs` and (when the caller can tell) is abandoned. */
export function releaseStale(log: CasLog<Registry>, input: { change: string; agent: string; staleAfterMs: number; abandoned?: Abandoned; now?: number }, stamper?: Stamper) {
	const now = input.now ?? Date.now();
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const idle = now - Date.parse(held.active);
		if (idle <= input.staleAfterMs) return { refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
		const turn = input.abandoned ? await input.abandoned(held) : undefined;
		if (turn && !turn.abandoned) return { refused: `${input.change} isn't abandoned: it ${turn.why}` };
		return {
			state: {
				...state,
				claims: state.claims.filter((c) => c.change !== input.change),
				released: [...state.released, await stamped("release", { change: input.change, agent: held.agent, by: input.agent, at: new Date(now).toISOString(), reason: "stale", stale: true, lastActive: held.active } as ReleaseRecord, stamper, "verifiedBy")],
			},
			text: `${input.agent} releases ${input.change}'s claim, idle for ${Math.round(idle / 60_000)} minutes`,
		};
	});
}

/**
 * Record a branch changes may land on, at the commit it starts from (once:
 * a branch already recorded keeps its record, which is returned).
 */
export function recordBranch(log: CasLog<Registry>, input: { name: string; base: string; from?: string; agent: string }, stamper?: Stamper) {
	let record: BranchRecord | undefined;
	return appendRecord<Registry, "known">(log, input.agent, empty, async (state) => {
		record = state.branches?.[input.name];
		if (record) return { refused: "known" };
		record = await stamped("branch", { base: input.base, ...(input.from ? { from: input.from } : {}), at: new Date().toISOString(), agent: input.agent }, stamper);
		const how = input.from ? `from ${input.from} at ${input.base.slice(0, 8)}` : `as it was, at ${input.base.slice(0, 8)}`;
		return { state: { ...state, branches: { ...state.branches, [input.name]: record } }, text: `${input.agent} starts changes landing on ${input.name}, ${how}` };
	}).then(() => record!);
}

/**
 * Register several new agent names at once, each with the hash of its new
 * key: one write for a crowd set up together, where one each took 2 s apiece
 * in turn. Refused, naming them, if any is registered already.
 */
export function registerAgents(log: CasLog<Registry>, agents: { agent: string; keyHash: string }[], stamper?: Stamper) {
	return appendRecord<Registry, string>(log, agents[0].agent, empty, async (state) => {
		const taken = agents.filter((a) => state.agents?.[a.agent]).map((a) => a.agent);
		if (taken.length) return { refused: `already registered: ${taken.join(", ")} (register each alone, with its agent key, to rotate it)` };
		const at = new Date().toISOString();
		const records = await Promise.all(agents.map(async (a) => [a.agent, await stamped("agent", { agent: a.agent, keyHash: a.keyHash, at }, stamper)] as const));
		return { state: { ...state, agents: { ...state.agents, ...Object.fromEntries(records) } }, text: `${agents.map((a) => a.agent).join(", ")} register` };
	});
}

/**
 * Register an agent name with the hash of its new key, or rotate the key of a
 * name the caller already holds (`holder`: the name its current key is for).
 * A name, once registered, is never given to anyone else.
 */
export function registerAgent(log: CasLog<Registry>, input: { agent: string; keyHash: string; holder?: string }, stamper?: Stamper) {
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		if (state.agents?.[input.agent] && input.holder !== input.agent) return { refused: `${input.agent} is registered: call with its agent key to rotate it` };
		const record = await stamped("agent", { agent: input.agent, keyHash: input.keyHash, at: new Date().toISOString() }, stamper);
		return { state: { ...state, agents: { ...state.agents, [input.agent]: record } }, text: `${input.agent} ${input.holder ? "rotates its key" : "registers"}` };
	});
}
