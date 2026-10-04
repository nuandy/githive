import type { CasLog } from "../election";
import { entriesOverlap } from "../open-mode";
import { appendRecord } from "./records";
import { type Stamper, stampPayload } from "./stamp";
import type { ReviewPolicy } from "./votes";

// Coordinator-free claims (see docs/coordinator-free.md). The registry is an
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
	/** Who made it, as Access verified them, and Blueprint's stamp over the record (written through the toolkit). */
	by?: string;
	stamp?: string;
}

/** A released claim: who released it, after which merge (if it merged), and whether it was released as stale. */
export interface ReleaseRecord {
	change: string;
	agent: string;
	by: string;
	at: string;
	reason: string;
	mergedAs?: string;
	stale?: boolean;
	/** The holder's last activity, for the audit to check a stale release against. */
	lastActive: string;
	/** Who released it, as Access verified them, and Blueprint's stamp (written through the toolkit). */
	verifiedBy?: string;
	stamp?: string;
}

/** The registry's state: the claims in force, and every release so far. */
export interface Registry {
	claims: ClaimRecord[];
	released: ReleaseRecord[];
	/** Main's commit when the mode started: the audit reads main after it. */
	baseline?: string;
	/** How many approvals a merge needs, and which roles veto. */
	policy?: ReviewPolicy;
	/** The project's checks, run on main plus a change before it merges. */
	verify?: string[];
	/** Blueprint's public key, to check the stamps on records and merges with. */
	stampKey?: string;
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

/** Start coordinator-free mode on a repo: the registry's first entry records main's baseline and the review policy. Harmless to repeat. */
export async function startFree(log: CasLog<Registry>, input: { baseline: string; policy: ReviewPolicy; verify?: string[]; stampKey?: string }) {
	const outcome = await appendRecord<Registry, "started">(log, "blueprint", empty, (state) =>
		state.baseline
			? { refused: "started" }
			: { state: { ...state, baseline: input.baseline, policy: input.policy, verify: input.verify ?? [], stampKey: input.stampKey }, text: `Coordinator-free mode starts at ${input.baseline}` },
	);
	return { started: outcome.ok };
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

/** A record with who wrote it and Blueprint's stamp over it, when written through the toolkit (`stamper`). */
async function stamped<T extends object>(kind: string, record: T, stamper: Stamper | undefined, byField: "by" | "verifiedBy" = "by"): Promise<T> {
	if (!stamper) return record;
	const withBy = { ...record, [byField]: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload(kind, withBy)) };
}

/** Claim `paths` for a change, if no other change's claim overlaps them; claiming again extends the change's claim. */
export async function claim(log: CasLog<Registry>, input: { change: string; agent: string; paths: string[]; intent: string }, stamper?: Stamper) {
	const outcome = await appendRecord<Registry, Conflict[]>(log, input.agent, empty, async (state) => {
		const conflicts = conflictsWith(state, input.paths, input.change);
		if (conflicts.length) return { refused: conflicts };
		const now = new Date().toISOString();
		const existing = state.claims.find((c) => c.change === input.change);
		const { by: _by, stamp: _stamp, ...base } = existing ?? ({} as Partial<ClaimRecord>);
		const record = await stamped(
			"claim",
			existing ? { ...(base as ClaimRecord), paths: [...existing.paths, ...input.paths.filter((p) => !existing.paths.includes(p))], active: now } : { ...input, since: now, active: now },
			stamper,
		);
		const claims = existing ? state.claims.map((c) => (c.change === input.change ? record : c)) : [...state.claims, record];
		return { state: { ...state, claims }, text: `${input.agent} claims ${input.paths.join(", ")} for ${input.change}: ${input.intent}` };
	});
	return outcome.ok ? outcome : { ok: false as const, conflicts: outcome.refused };
}

/** Release a change's claim: its holder's, after it merged (say which merge) or was given up. */
export function release(log: CasLog<Registry>, input: { change: string; agent: string; reason: string; mergedAs?: string }, stamper?: Stamper) {
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const record: ReleaseRecord = { change: input.change, agent: held.agent, by: input.agent, at: new Date().toISOString(), reason: input.reason, lastActive: held.active, ...(input.mergedAs ? { mergedAs: input.mergedAs } : {}) };
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

/** Release another agent's claim, if it has been idle longer than `staleAfterMs`. */
export function releaseStale(log: CasLog<Registry>, input: { change: string; agent: string; staleAfterMs: number; now?: number }, stamper?: Stamper) {
	const now = input.now ?? Date.now();
	return appendRecord<Registry, string>(log, input.agent, empty, async (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const idle = now - Date.parse(held.active);
		if (idle <= input.staleAfterMs) return { refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
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
