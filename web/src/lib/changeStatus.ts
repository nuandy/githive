import type { ChangeState } from "./status";

// How a change stands, in the words a person reading a pull request expects
// (see claimStatus.ts, which derives it from claims, and status.ts, which names each state).

export type Tone = "good" | "bad" | "warn" | "neutral" | "needs" | "accent";

/** A change's state (see status.ts). */
export type StatusKind = ChangeState;

export interface ChangeStatus {
	kind: StatusKind;
	label: string;
	tone: Tone;
	/** One sentence on what is happening and who acts next. */
	description: string;
}
