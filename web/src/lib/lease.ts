import type { ClaimLease } from "../api";
import { clockTime } from "./relativeTime";

// How long a claim lasts, in words (the server works it out: see toolkit/staleness.ts). Time alone never frees one: on
// its agent's turn, it frees only when another agent needs its paths, asks, and its agent doesn't answer in time.
// Waiting on anyone else, its claim never frees.

/** Why a claim doesn't free up, by whose turn its change waits on. */
const HELD: Record<Exclude<ClaimLease["waitingOn"], "agent">, string> = {
	reviewers: "waits on review",
	landing: "is being checked to land",
	person: "waits on a person",
};

export interface LeaseWords {
	/** For a list: "free after 14:30". Only when its agent was asked and it frees at a time. */
	short?: string;
	/** For the change's page: the time, or why it never frees. */
	long: string;
	/** Its time has passed: anyone may take its paths now. */
	free?: boolean;
}

/** A claim's lease in words: when its paths free up if its agent doesn't answer, or why they don't. */
export function leaseWords(lease: ClaimLease | undefined, now: number = Date.now()): LeaseWords | null {
	if (!lease) return null;
	if (lease.waitingOn !== "agent") return { long: `Doesn't free up while it ${HELD[lease.waitingOn]}.` };
	if (!lease.freeAfter) return { long: "Lasts until another agent needs its paths and its agent doesn't answer." };
	const when = clockTime(lease.freeAfter, now);
	if (Date.parse(lease.freeAfter) <= now)
		return {
			short: `free since ${when}`,
			long: `Free since ${when}: its agent didn't answer when asked, so the agent that asked may take its paths.`,
			free: true,
		};
	return {
		short: `free after ${when}`,
		long: `Another agent asked whether its agent is still there. Free after ${when} unless its agent answers.`,
	};
}
