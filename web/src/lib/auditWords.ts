import type { LandedChange, RepoSnapshot } from "../api";

// The audit's findings in words a person reads. Each rule the server's audit checks (src/toolkit/audit.ts) says what
// went wrong, and what someone can do about it. Any agent may revert a commit the audit reports (the toolkit's revert
// tool), and the audit then counts it resolved.

export interface RuleWords {
	/** What went wrong, as a heading: "Changed files outside its claim". */
	words: string;
	/** What a person can do. */
	remedy: string;
}

const REVERT = "have an agent revert it (GitHive's revert tool), and the audit counts it resolved";

export const RULES: Record<string, RuleWords> = {
	undeclared: {
		words: "Landed without GitHive's records",
		remedy: `It names no change, claims or votes, as a push made with plain git doesn't. Check what it changed; if it shouldn't be there, ${REVERT}.`,
	},
	unverified: {
		words: "Not stamped by GitHive",
		remedy: `Who made it, and what it says it checked, can't be verified. Check what it changed; if it wasn't made through GitHive, ${REVERT}.`,
	},
	"inside-another-claim": {
		words: "Changed a file another change holds",
		remedy: `Ask both changes' agents whether either's work was lost; if this one overwrote the other's, ${REVERT}.`,
	},
	"outside-claim": {
		words: "Changed files outside its claim",
		remedy: `Check the change to that file is wanted; if not, ${REVERT}. An agent claims a path before it changes it.`,
	},
	"merged-before-dependency": {
		words: "Landed before a change it waits on",
		remedy: `Check it works without that change; if it doesn't, ${REVERT} until that one lands.`,
	},
	untested: {
		words: "Landed without its checks passing as it landed",
		remedy: `Run the branch's checks now; if they fail, ${REVERT}.`,
	},
	"unjustified-revert": {
		words: "Reverted a commit the audit had nothing against",
		remedy: "Check the work it undid should go; if it should stay, land it again as a new change.",
	},
	"unknown-claims": {
		words: "Cited claims that aren't on record",
		remedy: `What it says it checked isn't in the claims' history, so nothing shows it held its files. Check what it changed; if it's not wanted, ${REVERT}.`,
	},
	"unverified-record": {
		words: "A record GitHive didn't stamp",
		remedy:
			"Someone wrote GitHive's records without it: a claim, release or vote that isn't stamped. Check who can push there; a vote without a stamp doesn't count.",
	},
	"released-before-merge": {
		words: "Landed after giving up its claim",
		remedy: `Check that no other change took those paths in between; if one did and this undid its work, ${REVERT}.`,
	},
	"unknown-votes": {
		words: "Cited votes that aren't on record",
		remedy: `Nothing shows it was reviewed. Review it now; if it shouldn't be there, ${REVERT}.`,
	},
	unapproved: {
		words: "Landed without the approvals it needed",
		remedy: `Review it now: if it should stay, nothing more is needed; if not, ${REVERT}.`,
	},
	"released-others-claim": {
		words: "Released another agent's claim while it was at work",
		remedy: "Ask that agent whether its work was lost; it can claim its paths again and carry on.",
	},
};

/** A rule in words, and what to do; one the dashboard doesn't know yet in words made from its id. */
export function violationWords(rule: string): RuleWords {
	const known = Object.hasOwn(RULES, rule) ? RULES[rule] : undefined;
	if (known) return known;
	const plain = rule.replace(/[-_]+/g, " ").trim();
	return {
		words: plain.charAt(0).toUpperCase() + plain.slice(1),
		remedy: `Look at what the commit changed; if it shouldn't be there, ${REVERT}.`,
	};
}

const sameCommit = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The change a commit is the head of, by a full or short hash: an open change's (its claim's head), else one landed
 * on the branch (as History has it). Undefined for an older head, or a commit no change names.
 */
export function changeAt(
	commit: string,
	claims: Pick<RepoSnapshot["claims"][number], "change" | "intent" | "head">[],
	landed: Pick<LandedChange, "change" | "title" | "head">[] = [],
): { change: string; title: string } | undefined {
	const open = claims.find((claim) => claim.head && sameCommit(claim.head, commit));
	// Its title as claimTitle has it: the first line of what it set out to do, or its id.
	if (open) return { change: open.change, title: open.intent.split("\n")[0]?.trim() || open.change };
	const done = landed.find((change) => sameCommit(change.head, commit));
	return done ? { change: done.change, title: done.title || done.change } : undefined;
}
