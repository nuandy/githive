import type { RepoSnapshot } from "../api";
import { type ClaimState, changeState, type StateContext } from "./status";

// Each claim's lamp: its change's state, in the colors, glyphs and patterns it has everywhere (status.ts), for the
// Claims map's rows and its key.

type Claim = RepoSnapshot["claims"][number];

/** Where a claim's change is, most urgent first (the order a path held by several shows): its state in force. */
export const LAMPS = [
	"needs-person",
	"changes-requested",
	"checks-failed",
	"abandoned",
	"landing",
	"approved",
	"in-review",
	"building",
] as const satisfies readonly ClaimState[];
export type Lamp = (typeof LAMPS)[number];

/**
 * What else a lamp reads: what's being checked to land, the votes (for when a change went back to its agent), who
 * may vote as each role, and the time.
 */
export type LampContext = StateContext;

/**
 * Where a claim's change is (see status.ts): waiting on a person, abandoned by its agent (see staleness.ts: the
 * toolkit frees it the same way), being checked to land, sent back, approved, pushed for review, or still being
 * built.
 */
export function lampOf(claim: Claim, context: LampContext = {}): Lamp {
	return changeState(claim, { ...context, now: context.now ?? Date.now() });
}

/** How many claims show each lamp. */
export function lampCounts(claims: Claim[], context: LampContext = {}): Record<Lamp, number> {
	const counts = Object.fromEntries(LAMPS.map((lamp) => [lamp, 0])) as Record<Lamp, number>;
	for (const claim of claims) counts[lampOf(claim, context)]++;
	return counts;
}
