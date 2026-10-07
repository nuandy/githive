import type { Tone } from "./changeStatus";

// A change's Conversation: what happened to it, oldest first, like a pull
// request's timeline (see freeTimeline.ts, which builds it from a
// coordinator-free change's history in Git).

export type TimelineKind = "opened" | "pushed" | "review" | "changes-requested" | "needs-you" | "merged" | "abandoned" | "note";

/** A vote, shown as a review card. */
export interface TimelineReview {
	/** The role reviewed for. */
	reviewer: string;
	/** Who reviewed, as recorded. */
	by?: string;
	head?: string;
	verdict: "approve" | "reject";
	summary?: string;
	evidence?: string;
	at?: string;
}

export interface TimelineItem {
	key: string;
	kind: TimelineKind;
	at?: string;
	tone: Tone;
	/** One line, already worded for people. */
	text: string;
	commit?: string;
	/** Where the commit can be browsed, when there is a place (the Code tab at that commit). */
	commitHref?: string;
	/** Longer text shown under the line (a commit message, a release's reason). */
	body?: string;
	review?: TimelineReview;
}
