import type { HiveEvent, RepoLanding, RepoSnapshot } from "../api";

// The hive: what each agent working on a repo is doing now, worked out from the repo's claims, votes and landing.
// No one assigns the work; this only shows what each agent chose.

type Claim = RepoSnapshot["claims"][number];

/** What an agent's change is doing, from the agent's side. */
export type HiveState = "building" | "revising" | "in-review" | "asking" | "landing" | "waiting" | "reviewed";

export interface HiveActivity {
	agent: string;
	state: HiveState;
	change: string;
	/** A few words on where it stands. */
	detail: string;
	/** When it last moved, for ordering. */
	at: string;
}

/** How long after its last vote a reviewer still counts as in the hive. */
export const RECENT_REVIEW_MS = 15 * 60_000;

/** The state of one claimed change, given the batch being checked. */
function stateOf(claim: Claim, rejected: boolean, checking: Set<string>): { state: HiveState; detail: string } {
	if (claim.attention) return { state: "asking", detail: `asking a person: ${claim.attention.reason}` };
	if (!claim.head) return { state: "building", detail: "nothing pushed yet" };
	if (claim.approval.approved && checking.has(claim.change))
		return { state: "landing", detail: "in the batch being checked" };
	if (claim.approval.approved) return { state: "waiting", detail: "approved, landing with the next batch" };
	if (rejected) return { state: "revising", detail: "changes asked for in review" };
	const { approvals, required } = claim.approval;
	return { state: "in-review", detail: `${approvals} of ${required} approvals` };
}

/** Every agent's activity: one row per claimed change, and one per agent that reviewed lately without a claim. */
export function hiveActivity(snapshot: RepoSnapshot, landing: RepoLanding | undefined, now = Date.now()) {
	const checking = new Set((landing?.checking?.changes ?? []).map((checked) => checked.change));
	const changeOfHead = new Map(snapshot.claims.flatMap((claim) => (claim.head ? [[claim.head, claim.change]] : [])));
	const rows: HiveActivity[] = snapshot.claims.map((claim) => {
		const onHead = snapshot.votes.filter((vote) => vote.commit === claim.head);
		const rejected = onHead.some((vote) => vote.verdict === "reject");
		return { agent: claim.agent, change: claim.change, at: claim.active, ...stateOf(claim, rejected, checking) };
	});
	const claiming = new Set(snapshot.claims.map((claim) => claim.agent));
	const lastVote = new Map<string, RepoSnapshot["votes"][number]>();
	for (const vote of snapshot.votes) {
		const recent = now - Date.parse(vote.at) <= RECENT_REVIEW_MS;
		const later = vote.at > (lastVote.get(vote.reviewer)?.at ?? "");
		if (recent && later && !claiming.has(vote.reviewer)) lastVote.set(vote.reviewer, vote);
	}
	for (const [reviewer, vote] of lastVote) {
		const change = changeOfHead.get(vote.commit) ?? vote.commit.slice(0, 8);
		const verdict = vote.verdict === "approve" ? "approved" : "asked for changes to";
		rows.push({ agent: reviewer, state: "reviewed", change, detail: `${verdict} ${change}`, at: vote.at });
	}
	return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** How many agents are in each state, for the hive's headline. */
export function hiveCounts(rows: HiveActivity[]) {
	const agents = new Set(rows.map((row) => row.agent)).size;
	const count = (...states: HiveState[]) => rows.filter((row) => states.includes(row.state)).length;
	return {
		agents,
		building: count("building", "revising"),
		inReview: count("in-review"),
		landing: count("landing", "waiting"),
	};
}

/** One line of the hive's live feed: who did what, to which change. */
export interface FeedLine {
	kind: HiveEvent["kind"];
	agent: string;
	/** What they did, before the change it was done to. */
	action: string;
	change?: string;
	/** The short commit, when no change is known for it. */
	commit?: string;
	note?: string;
	at: string;
}

// What each kind of event says its agent did. Awareness events name another agent, or the files, in it.
const ACTIONS: Record<HiveEvent["kind"], string | ((event: HiveEvent, other: string) => string)> = {
	claimed: "claimed",
	released: "released",
	pushed: "pushed to",
	voted: "voted on",
	merging: "asked to land",
	landed: "landed",
	failed: "failed to land",
	asked: "asked a person about",
	reverted: "reverted",
	added: "added work",
	building: "started a hosted builder",
	interface: (_event, other) => `landed an interface change ${other} uses`,
	heads_up: (_event, other) => `and ${other} are changing things each other uses`,
	noted: (_event, other) => `left a note for ${other}`,
	conflicted: (event) => `'s merge conflicted${event.detail ? ` on ${event.detail}` : ""}`,
};

/**
 * An event as a line of the feed. A push names only its change, so its agent is the one claiming the change; a
 * vote names only its commit, so its change is the claim whose head that is.
 */
export function feedLine(event: HiveEvent, snapshot: RepoSnapshot): FeedLine {
	const claimOf = (change: string | undefined) => snapshot.claims.find((claim) => claim.change === change);
	const onHead = event.commit ? snapshot.claims.find((claim) => claim.head === event.commit) : undefined;
	const change = event.change ?? onHead?.change;
	const agent = event.agent ?? claimOf(change)?.agent ?? "an agent";
	// The other agent an awareness event names; a heads-up's change is its own agent's.
	const other = event.other ?? (event.kind === "heads_up" ? undefined : claimOf(change)?.agent) ?? "another agent";
	const line: FeedLine = { kind: event.kind, agent, action: actionOf(event, other), at: event.at };
	if (change) line.change = change;
	else if (event.commit) line.commit = event.commit.slice(0, 8);
	const note = noteOf(event);
	if (note) line.note = note;
	return line;
}

/** What goes between a line's agent and its action: a space, or nothing before a possessive ("dan's merge"). */
export const afterAgent = (line: FeedLine) => (line.action.startsWith("'s ") ? "" : " ");

function actionOf(event: HiveEvent, other: string) {
	if (event.verdict === "approve") return "approved";
	if (event.verdict === "reject") return "asked for changes to";
	const action = ACTIONS[event.kind];
	return typeof action === "string" ? action : action(event, other);
}

function noteOf(event: HiveEvent) {
	if (event.kind === "voted" && event.detail) return `as ${event.detail}`;
	// A conflict's files are in its action already.
	return event.kind === "conflicted" ? undefined : event.detail;
}
