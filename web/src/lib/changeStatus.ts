// How a change stands, in the words a person reading a pull request expects
// (see claimStatus.ts, which derives it from claims).

export type Tone = "good" | "bad" | "warn" | "neutral" | "needs" | "accent";

export type StatusKind =
	"merged" | "abandoned" | "needs-you" | "approved" | "changes-requested" | "in-review" | "draft";

export interface ChangeStatus {
	kind: StatusKind;
	label: string;
	tone: Tone;
	/** One sentence on what is happening and who acts next. */
	description: string;
}
