import type { RepoLanding, RepoSnapshot, SteeringFlag } from "../api";
import { settingsForBranch } from "../../../src/toolkit/branch-rules";
import { abandoned } from "../../../src/toolkit/staleness";
import type { Tone } from "./changeStatus";

// Where a change stands, one way everywhere it shows: the Changes list, a change's page, the Hive's cells, strip and
// goal rows, Territory's squares, lamps and every legend. Each state has one noun, one color, one icon and one
// pattern. The colors are the Hive's stages (theme.css): the link's blue while it's built or reviewed, amber only
// while it's checked to land, green once approved or landed, red where it needs a person or went back to its agent.
// Color never says it alone: a glyph or a pattern says it too.

type Claim = RepoSnapshot["claims"][number];
type Vote = RepoSnapshot["votes"][number];
type Policy = RepoSnapshot["policy"];
/** What a repo holds its changes to: its review policy, its branch rules and its project's branch (see claimPolicy). */
export type RepoPolicy = Pick<RepoSnapshot, "policy" | "branchRules" | "branch">;

/** Every state a change can be in, loudest first: the order a cell held by several shows. */
export const CHANGE_STATES = [
	"needs-person",
	"changes-requested",
	"checks-failed",
	"abandoned",
	"landing",
	"approved",
	"in-review",
	"building",
	"landed",
	"released",
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];
/** The states of a change in force: landed and released are how one ends. */
export type ClaimState = Exclude<ChangeState, "landed" | "released">;

export interface StateLook {
	/** Its one noun: "Needs a person". */
	label: string;
	/** The same words in lowercase, for the Hive's cells, goal rows and legends. */
	short: string;
	/** Its pill's tone (see Badge). */
	tone: Tone;
	/** The theme color it's drawn in, the Hive's stage where it has one: var(--stage-building) in SVG and styles. */
	color: "stage-building" | "stage-review" | "stage-landing" | "stage-landed" | "good" | "bad" | "neutral";
	/** Its words' color. */
	text: string;
	/** A square, swatch or lamp in its color and pattern: edge, fill, and its glyph's ink. Its caller sizes it. */
	mark: string;
	/** Drawn on its mark, so color doesn't say it alone; none where the pattern does. */
	glyph?: "!" | "×" | "✓" | "●";
	/** How its mark draws: an edge and a tint, a dashed edge, filled, or a hollow ring. */
	pattern: "solid" | "dashed" | "filled" | "ring";
	/** Its icon (see Icon). */
	icon: "alert" | "x" | "x-circle" | "pause" | "clock" | "check" | "eye" | "pull" | "merge" | "ban";
}

export const STATES: Record<ChangeState, StateLook> = {
	"needs-person": {
		label: "Needs a person",
		short: "needs a person",
		tone: "bad",
		color: "bad",
		text: "text-bad",
		mark: "border-bad bg-bad text-bad-foreground",
		glyph: "!",
		pattern: "filled",
		icon: "alert",
	},
	"changes-requested": {
		label: "Changes requested",
		short: "changes requested",
		tone: "bad",
		color: "bad",
		text: "text-bad",
		mark: "border-bad bg-bad-soft text-bad",
		glyph: "×",
		pattern: "solid",
		icon: "x",
	},
	"checks-failed": {
		label: "Checks failed",
		short: "checks failed",
		tone: "bad",
		color: "bad",
		text: "text-bad",
		mark: "border-bad bg-bad-soft text-bad",
		glyph: "×",
		pattern: "solid",
		icon: "x-circle",
	},
	abandoned: {
		label: "Abandoned, free to take",
		short: "abandoned, free to take",
		tone: "neutral",
		color: "neutral",
		text: "text-neutral",
		mark: "border-neutral bg-transparent",
		pattern: "ring",
		icon: "pause",
	},
	landing: {
		label: "Landing",
		short: "landing",
		tone: "warn",
		color: "stage-landing",
		text: "text-warn",
		mark: "border-stage-landing bg-stage-landing/25 text-stage-landing",
		glyph: "●",
		pattern: "solid",
		icon: "clock",
	},
	approved: {
		label: "Approved",
		short: "approved",
		tone: "good",
		color: "good",
		text: "text-good",
		mark: "border-good bg-good-soft text-good",
		glyph: "✓",
		pattern: "solid",
		icon: "check",
	},
	"in-review": {
		label: "In review",
		short: "in review",
		tone: "accent",
		color: "stage-review",
		text: "text-link",
		mark: "border-dashed border-stage-review bg-stage-review/8",
		pattern: "dashed",
		icon: "eye",
	},
	building: {
		label: "Building",
		short: "building",
		tone: "accent",
		color: "stage-building",
		text: "text-link",
		mark: "border-stage-building bg-stage-building/25",
		pattern: "solid",
		icon: "pull",
	},
	landed: {
		label: "Landed",
		short: "landed",
		tone: "good",
		color: "stage-landed",
		text: "text-good",
		mark: "border-stage-landed bg-stage-landed text-good-foreground",
		glyph: "✓",
		pattern: "filled",
		icon: "merge",
	},
	released: {
		label: "Released",
		short: "released",
		tone: "neutral",
		color: "neutral",
		text: "text-neutral",
		mark: "border-neutral bg-transparent",
		pattern: "ring",
		icon: "ban",
	},
};

/**
 * What else a change's state reads: the votes, the batch being checked, the repo's review settings (who may vote as
 * each role, on the change's own branch), and the time.
 */
export interface StateContext {
	votes?: Vote[];
	landing?: Pick<RepoLanding, "checking"> | undefined;
	/** Without them, no role is taken to be people's alone. */
	settings?: RepoPolicy | undefined;
	/** Without it, a change is never called abandoned (the Hive tells its story to the end instead). */
	now?: number | undefined;
}

/**
 * Where a change in force stands. A person's question comes first; then, given the time, an agent gone quiet on its
 * turn (as staleness.ts frees it); its head being checked to land; rejections on its head before its approval; and a
 * vote only people may give before plain review.
 */
export function changeState(claim: Claim, context: StateContext = {}): ClaimState {
	const { votes = [], landing, settings, now } = context;
	const waiting = waitingOn(claim, { votes, settings });
	if (waiting?.kind === "question") return "needs-person";
	const checking =
		!!claim.head &&
		!!landing?.checking?.changes.some((checked) => checked.change === claim.change && checked.head === claim.head);
	if (now !== undefined && isAbandoned(claim, votes, checking, now)) return "abandoned";
	// The batch being checked lands it all the same, so a veto or a rejection cast meanwhile doesn't change where it
	// stands (claimStatus says who asked).
	if (checking) return "landing";
	if (claim.approval.vetoedBy.length) return "changes-requested";
	// A batch that failed leaves the change approved ("checks" blocks nothing) and its head rejected.
	const rejected = rejectionsOnHead(claim, votes);
	if (rejected.some((vote) => vote.role === "checks")) return "checks-failed";
	if (rejected.length) return "changes-requested";
	if (claim.approval.approved) return "approved";
	if (!claim.head) return "building";
	if (claim.hosted?.reviewers.some((reviewer) => reviewer.verdict === "reject")) return "changes-requested";
	if (waiting) return "needs-person";
	return "in-review";
}

/** Whether its agent's turn has gone unanswered longer than allowed (see the toolkit's staleness.ts). */
function isAbandoned(claim: Claim, votes: Vote[], landing: boolean, now: number): boolean {
	const onHead = claim.head ? votes.filter((vote) => vote.commit === claim.head && vote.reviewer !== claim.agent) : [];
	const signs = {
		active: claim.active,
		head: claim.head,
		votes: onHead.map((vote) => ({ verdict: vote.verdict, at: vote.at })),
		approved: claim.approval.approved,
		vetoed: claim.approval.vetoedBy.length > 0,
		landing,
		asked: false,
	};
	return abandoned(signs, now).abandoned;
}

/** Rejections on the change's current head from anyone but its agent: a reviewer's, or failed checks'. */
export function rejectionsOnHead(claim: Claim, votes: Vote[]): Vote[] {
	if (!claim.head) return [];
	return votes.filter(
		(vote) => vote.commit === claim.head && vote.reviewer !== claim.agent && vote.verdict === "reject",
	);
}

/** What a change waits on a person for: its agent's question (or a failed builder), or a vote only people give. */
export type HeldFor =
	| { kind: "question"; change: string; agent: string; reason: string; at: string; urgency?: number }
	| { kind: "vote"; change: string; role: string };

/** What a person is asked to look at: what a change waits on them for, or text Clef flags (steeringOn). */
export type Waiting = HeldFor | { kind: "steering"; change: string; flags: SteeringFlag[] };

/**
 * What, if anything, a change needs a person for: what its agent asks (GitHive's failed builder asks too), or, once
 * pushed and not sent back, a vote as a role only people may vote as under the policy it's held to. Failed checks are
 * its agent's to fix. The server's repo summaries count the same (dashboard.ts, waitingOnPerson).
 */
export function waitingOn(claim: Claim, context: Pick<StateContext, "votes" | "settings"> = {}): HeldFor | undefined {
	const { attention, change } = claim;
	if (attention)
		return {
			kind: "question",
			change,
			agent: attention.agent,
			reason: attention.reason,
			at: attention.at,
			...(attention.urgency === undefined ? {} : { urgency: attention.urgency }),
		};
	const builder = claim.hosted?.builder;
	if (builder?.status === "failed")
		return {
			kind: "question",
			change,
			agent: "githive-builder",
			reason: `GitHive's builder failed${builder.error ? `: ${builder.error}` : ""}`,
			at: claim.active,
		};
	const { approval } = claim;
	if (!claim.head || approval.approved || approval.vetoedBy.length) return undefined;
	if (rejectionsOnHead(claim, context.votes ?? []).length) return undefined;
	if (claim.hosted?.reviewers.some((reviewer) => reviewer.verdict === "reject")) return undefined;
	const policy = context.settings && claimPolicy(claim, context.settings);
	const role = (approval.awaiting ?? []).find((each) => peopleOnly(policy, each));
	return role ? { kind: "vote", change, role } : undefined;
}

/**
 * Text about a change Clef found steering the agents who read it, for a person to look at. Unlike what waitingOn
 * finds, it holds nothing up, so a change's state doesn't change with it.
 */
export function steeringOn(claim: Claim): Waiting | undefined {
	return claim.steering?.length ? { kind: "steering", change: claim.change, flags: claim.steering } : undefined;
}

/** What GitHub's change is held to while the repo trusts GitHub's changes: no review (the server's TRUSTED_POLICY). */
const TRUSTED: Policy = { required: 0, vetoes: [] };

/**
 * The policy a change is held to, as the server holds it (claimPolicy): none for GitHub's change while the repo trusts
 * it, else that of the branch it lands on, the repo's or a branch rule's.
 */
export function claimPolicy(claim: Pick<Claim, "into" | "trusted">, settings: RepoPolicy): Policy {
	if (claim.trusted) return TRUSTED;
	const project = settings.branch ?? "main";
	const repo = { policy: settings.policy, verify: [], rules: settings.branchRules, project };
	return settingsForBranch(repo, claim.into ?? project).policy;
}

/**
 * Whether only people may vote as a role: it has holders, and each is people ("person:*") or one person. A team isn't:
 * its members' agents may vote as it; nor is a pool of one person's agents ("person:<id>/*").
 */
export function peopleOnly(policy: Policy | undefined, role: string): boolean {
	const holders = policy?.grants?.[role] ?? ["person:*", "githive"];
	const person = (holder: string) => holder === "person:*" || /^person:[^/]+$/.test(holder);
	return holders.length > 0 && holders.every(person);
}
