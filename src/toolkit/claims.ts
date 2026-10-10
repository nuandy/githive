import type { CasLog } from "../record-log";
import { entriesOverlap } from "../claim-paths";
import { appendRecord } from "./records";
import { scopedInto } from "./branch-scope";
import type { BranchRule } from "./branch-rules";
import { type Stamper, stampPayload } from "./stamp";
import type { ReviewPolicy } from "./votes";

// Claims (see docs/design.md). The registry is an append-only log in Git. An agent claims by reading the tip,
// checking that no active claim overlaps its paths and appending on that tip. The append is compare-and-swap, so
// of two overlapping claims made at once only one lands. An agent could skip the check, and the audit would show it.

export interface ClaimRecord {
	change: string;
	agent: string;
	paths: string[];
	intent: string;
	since: string;
	/** Its holder's last claim or extension. A claim idle long enough may be released by anyone. */
	active: string;
	/** The claimant's verified identity, set when the claim is written through the toolkit. */
	by?: string;
	stamp?: string;
	/** The target branch when not the project's. Only on claims the tools return, never stored (see branch-scope.ts). */
	into?: string;
	/** Changes it depends on. It merges only once each has merged into its target branch. */
	after?: string[];
	/** For a change that merges a whole branch, that branch. Its tip is the change's head. */
	source?: string;
}

export interface ReleaseRecord {
	change: string;
	agent: string;
	by: string;
	at: string;
	reason: string;
	mergedAs?: string;
	/** The branch it merged into when not the project's, for changes that wait on it. */
	into?: string;
	stale?: boolean;
	/** The holder's last activity, which the audit checks a stale release against. */
	lastActive: string;
	/** The releaser's verified identity, set when the release is written through the toolkit. */
	verifiedBy?: string;
	stamp?: string;
}

/** A branch changes land on besides the project's, made by a claim (`from` a branch) or adopted as it was. */
export interface BranchRecord {
	/** Its commit when GitHive first had a change land on it. */
	base: string;
	/** The branch it was made from. Absent for a branch that existed before GitHive. */
	from?: string;
	at: string;
	agent: string;
	by?: string;
	stamp?: string;
}

export interface Registry {
	claims: ClaimRecord[];
	released: ReleaseRecord[];
	/** The repo's default branch when GitHive started on it. Older registries lack it and mean main. */
	branch?: string;
	/** The branch's commit when GitHive started on it. The audit reads the branch from there. */
	baseline?: string;
	/** Other branches changes land on, with where each started, as `baseline` is for the project's branch. */
	branches?: Record<string, BranchRecord>;
	/** Patterns the checks skip (see check-scope.ts). Absent means the defaults; [] means never skip. */
	skipChecks?: string[];
	/** Settings for other branches by pattern, first match wins (see branch-rules.ts). */
	branchRules?: BranchRule<ReviewPolicy>[];
	policy?: ReviewPolicy;
	/** The checks run on the branch plus a change before it merges. ["github-actions"] runs them on GitHub. */
	verify?: string[];
	/** The connected GitHub repo (owner/name), which main is pushed back to after every landing. */
	github?: { repo: string };
	stampKey?: string;
	/** When set, claims are sharded this many path segments deep (see shards.ts), below this registry. */
	shardDepth?: number;
	/** How many records repos hold the shards. Absent means the project repo. */
	recordsRepos?: number;
	/** Shard this deep, over this many records repos, once load calls for it (see shardingReason). */
	autoShard?: { depth: number; recordsRepos: number };
	/** When and why claims were sharded. Every claim outside this registry since has an index (see shards.ts). */
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

/** Starts GitHive on a repo by writing the registry's first entry. Harmless to repeat. */
export async function startRepo(
	log: CasLog<Registry>,
	input: {
		baseline: string;
		branch?: string;
		policy: ReviewPolicy;
		verify?: string[];
		stampKey?: string;
		shardDepth?: number;
		recordsRepos?: number;
		autoShard?: Registry["autoShard"];
	},
) {
	const outcome = await appendRecord<Registry, "started">(log, "githive", empty, (state) => {
		if (state.baseline) return { refused: "started" };
		const sharding: Partial<Registry> = input.shardDepth
			? {
					shardDepth: input.shardDepth,
					...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}),
					shardedAt: new Date().toISOString(),
					shardedBecause: "asked for at the start",
				}
			: input.autoShard
				? { autoShard: input.autoShard }
				: {};
		return {
			state: {
				...state,
				baseline: input.baseline,
				...(input.branch ? { branch: input.branch } : {}),
				policy: input.policy,
				verify: input.verify ?? [],
				stampKey: input.stampKey,
				...sharding,
			},
			text: `GitHive starts at ${input.baseline}${input.branch ? ` on ${input.branch}` : ""}`,
		};
	});
	return { started: outcome.ok };
}

/** Changes a started repo's settings. The audit holds each merge to the settings in the state it cites. */
export async function changeSettings(
	log: CasLog<Registry>,
	input: {
		policy?: ReviewPolicy;
		verify?: string[];
		branchRules?: BranchRule<ReviewPolicy>[];
		skipChecks?: string[];
		github?: { repo: string } | null;
		by?: string;
	},
) {
	const outcome = await appendRecord<Registry, "not started" | "unchanged">(log, "githive", empty, (state) => {
		if (!state.baseline) return { refused: "not started" };
		const policy =
			input.policy && JSON.stringify(input.policy) !== JSON.stringify(state.policy) ? input.policy : undefined;
		const verify =
			input.verify && JSON.stringify(input.verify) !== JSON.stringify(state.verify ?? []) ? input.verify : undefined;
		const rules =
			input.branchRules && JSON.stringify(input.branchRules) !== JSON.stringify(state.branchRules ?? [])
				? input.branchRules
				: undefined;
		const skip =
			input.skipChecks && JSON.stringify(input.skipChecks) !== JSON.stringify(state.skipChecks)
				? input.skipChecks
				: undefined;
		const github = input.github !== undefined && input.github?.repo !== state.github?.repo ? input.github : undefined;
		if (!policy && !verify && !rules && !skip && github === undefined) return { refused: "unchanged" };
		const { github: _, ...rest } = state;
		const next: Registry = {
			...(github === null ? rest : state),
			...(policy ? { policy } : {}),
			...(verify ? { verify } : {}),
			...(rules ? { branchRules: rules } : {}),
			...(skip ? { skipChecks: skip } : {}),
			...(github ? { github } : {}),
		};
		const what = [
			policy && "the review policy",
			verify && `the checks (${verify.join("; ") || "none"})`,
			rules && `the branch rules (${rules.map((r) => r.pattern).join(", ") || "none"})`,
			skip && `what the checks skip (${skip.join(", ") || "nothing"})`,
			github !== undefined && (github ? `the GitHub repo (${github.repo})` : "the GitHub repo (none)"),
		]
			.filter(Boolean)
			.join(" and ");
		return { state: next, text: `Settings: ${what} changed${input.by ? ` by ${input.by}` : ""}` };
	});
	return outcome.ok ? { changed: true as const } : { changed: false as const, refused: outcome.refused };
}

/** When an unsharded registry should shard, based on load measured on Artifacts (see docs/design.md). */
export const SHARD_WHEN = { agents: 8, writesPerMinute: 15, windowMs: 5 * 60_000 };

/** Why `agent`'s claim should shard the registry first, or null if it needn't or can't. */
export function shardingReason(state: Registry | null | undefined, agent: string, now = Date.now()): string | null {
	if (!state?.autoShard || state.shardDepth) return null;
	const agents = new Set([...state.claims.map((c) => c.agent), agent]);
	if (agents.size >= SHARD_WHEN.agents) return `${agents.size} agents hold claims`;
	// Each claim made or extended, and each release, in the window was a write.
	const since = now - SHARD_WHEN.windowMs;
	const writes =
		state.claims.filter((c) => Date.parse(c.active) >= since).length +
		state.released.filter((r) => Date.parse(r.at) >= since).length;
	const perMinute = writes / (SHARD_WHEN.windowMs / 60_000);
	if (perMinute > SHARD_WHEN.writesPerMinute) return `${Math.round(perMinute)} claim writes a minute`;
	return null;
}

/** Shards the claims from here on, unless they already are. Claims held now stay in the registry. */
export function shardClaims(log: CasLog<Registry>, input: { depth: number; recordsRepos: number; reason: string }) {
	return appendRecord<Registry, "sharded">(log, "githive", empty, (state) =>
		state.shardDepth
			? { refused: "sharded" }
			: {
					state: {
						...state,
						shardDepth: input.depth,
						...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}),
						shardedAt: new Date().toISOString(),
						shardedBecause: input.reason,
					},
					text: `Claims are sharded from here on, ${input.depth} segments deep: ${input.reason}`,
				},
	);
}

export const activeClaims = (state: Registry | null | undefined) => state?.claims ?? [];

export function conflictsWith(state: Registry | null | undefined, paths: string[], change: string): Conflict[] {
	const conflicts: Conflict[] = [];
	for (const other of activeClaims(state)) {
		if (other.change === change) continue;
		for (const path of paths)
			for (const held of other.paths)
				if (entriesOverlap(path, held))
					conflicts.push({ path, held, change: other.change, agent: other.agent, intent: other.intent });
	}
	return conflicts;
}

export const changeTaken = (change: string, agent: string) =>
	`[409] ${change} is ${agent}'s change: claim under a change name of your own`;

// Adds the writer's identity and GitHive's stamp, when the record is written through the toolkit.
async function stamped<T extends object>(
	kind: string,
	record: T,
	stamper: Stamper | undefined,
	byField: "by" | "verifiedBy" = "by",
): Promise<T> {
	if (!stamper) return record;
	const withBy = { ...record, [byField]: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload(kind, withBy)) };
}

/**
 * Claims `paths` for a change if no other claim overlaps them. Claiming again extends the claim. With
 * `staleAfterMs`, an idle claim in the way is released as stale in the same write.
 */
export async function claim(
	log: CasLog<Registry>,
	input: {
		change: string;
		agent: string;
		paths: string[];
		intent: string;
		after?: string[];
		source?: string;
		staleAfterMs?: number;
		abandoned?: Abandoned;
		now?: number;
	},
	stamper?: Stamper,
) {
	const { staleAfterMs, abandoned, now: at, ...wanted } = input;
	// The change's paths before this claim, or null, so a claim that must back out can restore them.
	let previous: string[] | null = null;
	// The state the claim was written onto, which shows whether the registry was sharded by then.
	let seen: Registry | undefined;
	const outcome = await appendRecord<Registry, Conflict[]>(log, wanted.agent, empty, async (state) => {
		seen = state;
		const time = at ?? Date.now();
		const conflicts = conflictsWith(state, wanted.paths, wanted.change);
		// Stale means idle past the floor and, when the caller can tell, abandoned on its agent's turn. An abandoned
		// change under the same name can be taken over this way too.
		const sameName = state.claims.find((c) => c.change === wanted.change && c.agent !== wanted.agent);
		const stale = new Set<string>();
		for (const change of new Set([...conflicts.map((c) => c.change), ...(sameName ? [sameName.change] : [])])) {
			const held = state.claims.find((c) => c.change === change)!;
			if (
				staleAfterMs !== undefined &&
				time - Date.parse(held.active) > staleAfterMs &&
				(!abandoned || (await abandoned(held)).abandoned)
			)
				stale.add(change);
		}
		const blocking = conflicts.filter((c) => !stale.has(c.change));
		if (blocking.length) return { refused: blocking };
		const now = new Date(time).toISOString();
		const freedClaims = state.claims.filter((c) => stale.has(c.change));
		const releases: ReleaseRecord[] = [];
		for (const held of freedClaims)
			releases.push(
				await stamped(
					"release",
					{
						change: held.change,
						agent: held.agent,
						by: wanted.agent,
						at: now,
						reason: "stale",
						stale: true,
						lastActive: held.active,
					} as ReleaseRecord,
					stamper,
					"verifiedBy",
				),
			);
		const remaining = state.claims.filter((c) => !freedClaims.includes(c));
		const existing = remaining.find((c) => c.change === wanted.change);
		// A change belongs to its agent; another agent claiming under its name would extend someone else's claim.
		if (existing && existing.agent !== wanted.agent) throw new Error(changeTaken(wanted.change, existing.agent));
		previous = existing ? [...existing.paths] : null;
		const { by: _by, stamp: _stamp, ...base } = existing ?? ({} as Partial<ClaimRecord>);
		const record = await stamped(
			"claim",
			existing
				? {
						...(base as ClaimRecord),
						paths: [...existing.paths, ...wanted.paths.filter((p) => !existing.paths.includes(p))],
						active: now,
						...(existing.after || wanted.after
							? { after: [...new Set([...(existing.after ?? []), ...(wanted.after ?? [])])] }
							: {}),
						...(wanted.source ? { source: wanted.source } : {}),
					}
				: { ...wanted, since: now, active: now },
			stamper,
		);
		const claims = existing ? remaining.map((c) => (c.change === wanted.change ? record : c)) : [...remaining, record];
		const freed = freedClaims.length ? ` (releasing stale ${freedClaims.map((c) => c.change).join(", ")})` : "";
		return {
			state: { ...state, claims, released: [...state.released, ...releases] },
			text: `${wanted.agent} claims ${wanted.paths.join(", ")} for ${wanted.change}: ${wanted.intent}${freed}`,
		};
	});
	return outcome.ok ? { ...outcome, previous, seen } : { ok: false as const, conflicts: outcome.refused };
}

/**
 * Backs a claim out to `keep`, or releases it when `keep` is null. Used when a sharded claim turns out to overlap
 * another after it was written.
 */
export function withdraw(
	log: CasLog<Registry>,
	input: { change: string; agent: string; keep: string[] | null; reason: string },
	stamper?: Stamper,
) {
	if (input.keep === null)
		return release(log, { change: input.change, agent: input.agent, reason: input.reason }, stamper);
	const keep = input.keep;
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const { by: _by, stamp: _stamp, ...base } = held;
		const record = await stamped("claim", { ...base, paths: keep }, stamper);
		return {
			state: { ...state, claims: state.claims.map((c) => (c.change === input.change ? record : c)) },
			text: `${input.agent} withdraws ${input.change}'s claim to ${keep.join(", ")}: ${input.reason}`,
		};
	});
}

/** Releases a change's claim after it merged (naming the merge) or was given up. */
export function release(
	log: CasLog<Registry>,
	input: { change: string; agent: string; reason: string; mergedAs?: string },
	stamper?: Stamper,
) {
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const into = input.mergedAs ? scopedInto(held.paths) : undefined;
		const record: ReleaseRecord = {
			change: input.change,
			agent: held.agent,
			by: input.agent,
			at: new Date().toISOString(),
			reason: input.reason,
			lastActive: held.active,
			...(input.mergedAs ? { mergedAs: input.mergedAs } : {}),
			...(into ? { into } : {}),
		};
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

/** Whether a claim is abandoned (see staleness.ts). The caller decides, since the claims don't know heads or votes. */
export type Abandoned = (claim: ClaimRecord) => Promise<{ abandoned: boolean; why: string }>;

/** Releases another agent's claim if it has been idle past `staleAfterMs` and, if the caller can tell, abandoned. */
export function releaseStale(
	log: CasLog<Registry>,
	input: { change: string; agent: string; staleAfterMs: number; abandoned?: Abandoned; now?: number },
	stamper?: Stamper,
) {
	const now = input.now ?? Date.now();
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const idle = now - Date.parse(held.active);
		if (idle <= input.staleAfterMs)
			return { refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
		const turn = input.abandoned ? await input.abandoned(held) : undefined;
		if (turn && !turn.abandoned) return { refused: `${input.change} isn't abandoned: it ${turn.why}` };
		return {
			state: {
				...state,
				claims: state.claims.filter((c) => c.change !== input.change),
				released: [
					...state.released,
					await stamped(
						"release",
						{
							change: input.change,
							agent: held.agent,
							by: input.agent,
							at: new Date(now).toISOString(),
							reason: "stale",
							stale: true,
							lastActive: held.active,
						} as ReleaseRecord,
						stamper,
						"verifiedBy",
					),
				],
			},
			text: `${input.agent} releases ${input.change}'s claim, idle for ${Math.round(idle / 60_000)} minutes`,
		};
	});
}

/** Records a branch changes may land on, at its starting commit. A branch already recorded keeps its record. */
export function recordBranch(
	log: CasLog<Registry>,
	input: { name: string; base: string; from?: string; agent: string },
	stamper?: Stamper,
) {
	let record: BranchRecord | undefined;
	return appendRecord<Registry, "known">(log, input.agent, empty, async (state) => {
		record = state.branches?.[input.name];
		if (record) return { refused: "known" };
		record = await stamped(
			"branch",
			{
				base: input.base,
				...(input.from ? { from: input.from } : {}),
				at: new Date().toISOString(),
				agent: input.agent,
			},
			stamper,
		);
		const how = input.from
			? `from ${input.from} at ${input.base.slice(0, 8)}`
			: `as it was, at ${input.base.slice(0, 8)}`;
		return {
			state: { ...state, branches: { ...state.branches, [input.name]: record } },
			text: `${input.agent} starts changes landing on ${input.name}, ${how}`,
		};
	}).then(() => record!);
}

/**
 * Registers several new agent names in one write, so a crowd set up together doesn't queue one write per agent.
 * Refused if any name is already registered.
 */
export function registerAgents(log: CasLog<Registry>, agents: { agent: string; keyHash: string }[], stamper?: Stamper) {
	return appendRecord<Registry, string>(log, agents[0].agent, empty, async (state) => {
		const taken = agents.filter((a) => state.agents?.[a.agent]).map((a) => a.agent);
		if (taken.length)
			return {
				refused: `already registered: ${taken.join(", ")} (register each alone, with its agent key, to rotate it)`,
			};
		const at = new Date().toISOString();
		const records = await Promise.all(
			agents.map(
				async (a) => [a.agent, await stamped("agent", { agent: a.agent, keyHash: a.keyHash, at }, stamper)] as const,
			),
		);
		return {
			state: { ...state, agents: { ...state.agents, ...Object.fromEntries(records) } },
			text: `${agents.map((a) => a.agent).join(", ")} register`,
		};
	});
}

/**
 * Registers an agent name with the hash of its new key, or rotates the key of a name the caller holds (`holder`).
 * A registered name is never given to anyone else.
 */
export function registerAgent(
	log: CasLog<Registry>,
	input: { agent: string; keyHash: string; holder?: string },
	stamper?: Stamper,
) {
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		if (state.agents?.[input.agent] && input.holder !== input.agent)
			return { refused: `${input.agent} is registered: call with its agent key to rotate it` };
		const record = await stamped(
			"agent",
			{ agent: input.agent, keyHash: input.keyHash, at: new Date().toISOString() },
			stamper,
		);
		return {
			state: { ...state, agents: { ...state.agents, [input.agent]: record } },
			text: `${input.agent} ${input.holder ? "rotates its key" : "registers"}`,
		};
	});
}
