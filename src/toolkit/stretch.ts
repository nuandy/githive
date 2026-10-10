import type { Settled } from "./landing";

// A repo's last stretch of work: what landed since it last went STRETCH_GAP_MS with nothing landing. It lets the
// dashboard say that a burst of work finished ("200 changes landed in 32 minutes") instead of only going quiet.

/** How long with nothing landing ends a stretch; the next landing starts a new one. */
export const STRETCH_GAP_MS = 15 * 60_000;

export interface Stretch {
	landed: number;
	/** Changes put out because their checks failed. */
	failed: number;
	/** Who landed or was put out, each once. */
	agents: string[];
	/** When its first and last outcome settled. */
	from: string;
	to: string;
}

/** A stretch as the dashboard shows it: how many agents, not who. */
export interface StretchSummary {
	landed: number;
	failed: number;
	agents: number;
	from: string;
	to: string;
}

/** Whether an outcome settled at `at` belongs to `stretch`: within the gap after its last. */
function continues(stretch: Stretch | undefined, at: string): stretch is Stretch {
	if (!stretch) return false;
	return Date.parse(at) - Date.parse(stretch.to) <= STRETCH_GAP_MS;
}

/** The stretch with `outcomes` in it, or a new one when they came after a long enough gap. */
export function extendStretch(stretch: Stretch | undefined, outcomes: Settled[]): Stretch | undefined {
	let current = stretch;
	for (const outcome of [...outcomes].sort((a, b) => a.at.localeCompare(b.at))) {
		const base = continues(current, outcome.at)
			? current
			: { landed: 0, failed: 0, agents: [], from: outcome.at, to: outcome.at };
		current = {
			landed: base.landed + (outcome.how === "landed" ? 1 : 0),
			failed: base.failed + (outcome.how === "failed" ? 1 : 0),
			agents: base.agents.includes(outcome.agent) ? base.agents : [...base.agents, outcome.agent],
			from: base.from,
			to: outcome.at > base.to ? outcome.at : base.to,
		};
	}
	return current;
}

export function stretchSummary({ landed, failed, agents, from, to }: Stretch): StretchSummary {
	return { landed, failed, agents: agents.length, from, to };
}
