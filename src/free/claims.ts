import type { CasLog, LogCommit } from "../election";
import { entriesOverlap } from "../open-mode";

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
}

/** The registry's state: the claims in force. */
export interface Registry {
	claims: ClaimRecord[];
}

export interface Conflict {
	path: string;
	held: string;
	change: string;
	agent: string;
	intent: string;
}

export type ClaimOutcome = { ok: true; tip: string } | { ok: false; conflicts: Conflict[] };

const ATTEMPTS = 5;

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

/**
 * Append a change to the registry on the tip it was computed from. `next`
 * returns the new state and what to record, or the conflicts that stop it.
 * Retries when another agent's append got there first.
 */
async function append(log: CasLog<Registry>, agent: string, next: (state: Registry) => { state: Registry; text: string } | Conflict[]): Promise<ClaimOutcome> {
	for (let attempt = 1; ; attempt++) {
		const head = await log.read();
		const outcome = next(head?.commit.state ?? { claims: [] });
		if (Array.isArray(outcome)) return { ok: false, conflicts: outcome };
		const commit: LogCommit<Registry> = {
			term: 0,
			leader: agent,
			leaseUntil: 0,
			kind: "decisions",
			entries: [{ commit: "none", text: outcome.text, at: new Date().toISOString() }],
			state: outcome.state,
			batch: crypto.randomUUID(),
		};
		const tip = await log.append(head?.tip ?? null, commit);
		if (tip) return { ok: true, tip };
		if (attempt === ATTEMPTS) throw new Error("[503] the claims registry kept moving; try again");
	}
}

/** Claim `paths` for a change, if no other change's claim overlaps them. */
export function claim(log: CasLog<Registry>, input: { change: string; agent: string; paths: string[]; intent: string }) {
	return append(log, input.agent, (state) => {
		const conflicts = conflictsWith(state, input.paths, input.change);
		if (conflicts.length) return conflicts;
		const existing = state.claims.find((c) => c.change === input.change);
		const claims = existing
			? state.claims.map((c) => (c.change === input.change ? { ...c, paths: [...c.paths, ...input.paths.filter((p) => !c.paths.includes(p))] } : c))
			: [...state.claims, { ...input, since: new Date().toISOString() }];
		return { state: { claims }, text: `${input.agent} claims ${input.paths.join(", ")} for ${input.change}: ${input.intent}` };
	});
}

/** Release a change's claim (it merged or was given up). */
export function release(log: CasLog<Registry>, input: { change: string; agent: string; reason: string }) {
	return append(log, input.agent, (state) => ({
		state: { claims: state.claims.filter((c) => c.change !== input.change) },
		text: `${input.agent} releases ${input.change}: ${input.reason}`,
	}));
}
