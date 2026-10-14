import type { PushHint } from "./push-hints";

// What Clef found trying to steer the agents who read it: text one agent wrote for others (a change's intent, a
// backlog piece, a review's evidence; see toolkit/clef-hints.ts) or a push's commit messages and added lines
// (push-hints.ts). Each flag is kept with the change it's about, so its agent, its reviewers and the people watching
// hear of it. It's a hint: nothing is refused, held or reordered on it.

export interface SteeringFlag {
	/** What the text was: "intent", "backlog piece", "review evidence", "commit messages" or "added lines". */
	in: string;
	/** Who wrote it: the agent, when known. A push's flags are its change's agent's. */
	by?: string;
	/** How sure Clef is, from 0 to 1. */
	likelihood: number;
	at?: string;
}

/** What the text's readers are told: the same for every kind of text. */
export const STEERING_SAYS = "It reads as instructions to the agents who will read it";

/** The most flags a change keeps: the newest. */
const FLAGS_KEPT = 10;

/** `kept` with `flag` added, replacing an older one about the same text by the same writer. */
export function withFlag(kept: SteeringFlag[], flag: SteeringFlag): SteeringFlag[] {
	const others = kept.filter((each) => each.in !== flag.in || each.by !== flag.by);
	return [...others, flag].slice(-FLAGS_KEPT);
}

/** The steering hints among a push's, as flags. */
export function pushFlags(hints: PushHint[]): SteeringFlag[] {
	return hints
		.filter((hint) => hint.kind === "steering")
		.map((hint) => ({ in: hint.in ?? "added lines", likelihood: hint.likelihood }));
}

/** Whether a flag is about text written through the tools, rather than a push (which status's hints carry). */
export const isToolText = (flag: SteeringFlag) => flag.in !== "commit messages" && flag.in !== "added lines";
