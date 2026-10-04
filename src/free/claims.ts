import type { CasLog } from "../election";
import { entriesOverlap } from "../open-mode";
import { appendRecord } from "./records";

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
}

/** The registry's state: the claims in force, and every release so far. */
export interface Registry {
	claims: ClaimRecord[];
	released: ReleaseRecord[];
}

export interface Conflict {
	path: string;
	held: string;
	change: string;
	agent: string;
	intent: string;
}

const empty = (): Registry => ({ claims: [], released: [] });

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

/** Claim `paths` for a change, if no other change's claim overlaps them; claiming again extends the change's claim. */
export async function claim(log: CasLog<Registry>, input: { change: string; agent: string; paths: string[]; intent: string }) {
	const outcome = await appendRecord<Registry, Conflict[]>(log, input.agent, empty, (state) => {
		const conflicts = conflictsWith(state, input.paths, input.change);
		if (conflicts.length) return { refused: conflicts };
		const now = new Date().toISOString();
		const existing = state.claims.find((c) => c.change === input.change);
		const claims = existing
			? state.claims.map((c) => (c.change === input.change ? { ...c, paths: [...c.paths, ...input.paths.filter((p) => !c.paths.includes(p))], active: now } : c))
			: [...state.claims, { ...input, since: now, active: now }];
		return { state: { ...state, claims }, text: `${input.agent} claims ${input.paths.join(", ")} for ${input.change}: ${input.intent}` };
	});
	return outcome.ok ? outcome : { ok: false as const, conflicts: outcome.refused };
}

/** Release a change's claim: its holder's, after it merged (say which merge) or was given up. */
export function release(log: CasLog<Registry>, input: { change: string; agent: string; reason: string; mergedAs?: string }) {
	return appendRecord<Registry, string>(log, input.agent, empty, (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		return {
			state: {
				claims: state.claims.filter((c) => c.change !== input.change),
				released: [...state.released, { change: input.change, agent: held.agent, by: input.agent, at: new Date().toISOString(), reason: input.reason, mergedAs: input.mergedAs, lastActive: held.active }],
			},
			text: `${input.agent} releases ${input.change}${input.mergedAs ? ` after merging ${input.mergedAs}` : ""}: ${input.reason}`,
		};
	});
}

/** Release another agent's claim, if it has been idle longer than `staleAfterMs`. */
export function releaseStale(log: CasLog<Registry>, input: { change: string; agent: string; staleAfterMs: number; now?: number }) {
	const now = input.now ?? Date.now();
	return appendRecord<Registry, string>(log, input.agent, empty, (state) => {
		const held = state.claims.find((c) => c.change === input.change);
		if (!held) return { refused: `${input.change} holds no claim` };
		const idle = now - Date.parse(held.active);
		if (idle <= input.staleAfterMs) return { refused: `${input.change}'s claim was active ${Math.round(idle / 1000)}s ago; it isn't stale` };
		return {
			state: {
				claims: state.claims.filter((c) => c.change !== input.change),
				released: [...state.released, { change: input.change, agent: held.agent, by: input.agent, at: new Date(now).toISOString(), reason: "stale", stale: true, lastActive: held.active }],
			},
			text: `${input.agent} releases ${input.change}'s claim, idle for ${Math.round(idle / 60_000)} minutes`,
		};
	});
}
