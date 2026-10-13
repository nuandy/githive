import type { Goal, GoalStepKind } from "./goals";
import { timeOf } from "./model";

// What moves on the Hive tab when something happens. The live feed only says "something changed", so what happened
// is found by comparing the goals just read with the ones drawn before. Only what happens while the page is open
// moves: the first read is drawn settled. A burst ripples, oldest first, and past a few the rest just appear.

export type Motion =
	"arrived" | "pushed" | "approved" | "changes-asked" | "asking" | "checking" | "failed" | "landed" | "released";

export interface GoalMotion {
	/** The goal's key. */
	key: string;
	motion: Motion;
	/** When it happened, for ordering a burst. */
	at: string;
	/** How long to wait before playing it, in ms, so a burst ripples. */
	delay: number;
}

/** The gap between motions in a burst. */
export const RIPPLE_MS = 80;
/** Past this many motions in one read, the rest just appear. */
export const MOST_MOTIONS = 10;

const MOTION_OF: Partial<Record<GoalStepKind, Motion>> = {
	pushed: "pushed",
	approved: "approved",
	"changes-asked": "changes-asked",
	asked: "asking",
	merging: "checking",
	checking: "checking",
	failed: "failed",
	landed: "landed",
	released: "released",
};

const stepKey = (step: Goal["steps"][number]) => `${step.kind}@${step.at}@${step.by ?? ""}`;

/** What happened between two reads of the goals, oldest first, each with its delay. Nothing on the first read. */
export function goalMotions(before: Goal[] | undefined, after: Goal[], now = Date.now()): GoalMotion[] {
	if (!before) return [];
	const was = new Map(before.map((goal) => [goal.key, goal]));
	const found: Omit<GoalMotion, "delay">[] = [];
	for (const goal of after) {
		const old = was.get(goal.key);
		if (!old) {
			// A goal that arrived and finished between two reads has nothing to arrive into.
			if (!goal.finished) found.push({ key: goal.key, motion: "arrived", at: goal.announced });
			continue;
		}
		const seen = new Set(old.steps.map(stepKey));
		const fresh = goal.steps.filter((step) => !seen.has(stepKey(step)));
		const motions = fresh.flatMap((step) => {
			const motion = MOTION_OF[step.kind];
			return motion ? [{ key: goal.key, motion, at: step.at }] : [];
		});
		// The state can move without a step we know of (the batch being checked comes from the landing).
		if (!motions.length && old.state !== goal.state) {
			const motion = STATE_MOTION[goal.state];
			if (motion) motions.push({ key: goal.key, motion, at: goal.finished ?? new Date(now).toISOString() });
		}
		found.push(...motions);
	}
	found.sort((a, b) => (timeOf(a.at) ?? 0) - (timeOf(b.at) ?? 0));
	return found.slice(0, MOST_MOTIONS).map((motion, index) => ({ ...motion, delay: index * RIPPLE_MS }));
}

const STATE_MOTION: Partial<Record<Goal["state"], Motion>> = {
	landing: "checking",
	landed: "landed",
	released: "released",
	"needs-person": "asking",
	"changes-requested": "changes-asked",
	"checks-failed": "changes-asked",
	approved: "approved",
};

/** How long each motion plays, so its class can be taken off after. */
export const MOTION_MS: Record<Motion, number> = {
	arrived: 2400,
	pushed: 900,
	approved: 1200,
	"changes-asked": 1600,
	asking: 1600,
	checking: 1200,
	failed: 1600,
	landed: 2000,
	released: 1200,
};

/** Which motions are worth announcing to a screen reader, and how. */
export function announcement(goal: Pick<Goal, "agent" | "title">, motion: Motion): string | undefined {
	if (motion === "landed") return `${goal.agent} landed ${goal.title}`;
	if (motion === "asking") return `${goal.agent} is asking a person about ${goal.title}`;
	if (motion === "failed") return `${goal.title} failed its checks`;
	return undefined;
}
