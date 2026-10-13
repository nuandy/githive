import type { ClaimState } from "./status";

// Each claim's lamp: its change's state (status.ts, changeState), in the colors, glyphs and patterns it has
// everywhere, for the Claims map's rows and its key.

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
