// When a claim is abandoned, by whose turn it is. A claim isn't stale just
// because its agent has been quiet: an agent that pushed and waits for review,
// or whose change is being checked to land, or that asked a person, is waiting
// its turn. Only a change waiting on its own agent can be abandoned: nothing
// pushed yet, changes asked for (failed checks reject its head too), or
// approved and not merged.
// Then, after a while with no sign of the agent, anyone may take its paths.
//
// Pure, with no imports: the toolkit decides with it, and the dashboard shows
// the same thing (web/tsconfig.json includes this file).

/** How long a claim may go without its agent claiming again, before anything is pushed. */
export const BUILDING_IDLE_MS = 30 * 60_000;
/** How long a change may wait on its agent once something is pushed: to revise (failed checks too), or merge. */
export const AGENT_TURN_IDLE_MS = 2 * 60 * 60_000;

/** Who the change waits on. */
export type Turn = "agent" | "reviewers" | "landing" | "person";

/** What's known of a change, to say whose turn it is. */
export interface ChangeSigns {
	/** When its agent last claimed (claiming again keeps a claim active). */
	active: string;
	/** Its pushed head, or null while nothing is pushed. */
	head: string | null;
	/** The votes on that head (the author's own don't count, and aren't passed). */
	votes: { verdict: "approve" | "reject"; at: string }[];
	/** Whether the head has the approvals it needs. */
	approved: boolean;
	/** Roles that can block and rejected it. */
	vetoed?: boolean;
	/** Being checked to land now, in a batch. */
	landing: boolean;
	/** A question for a person waits on it. */
	asked: boolean;
}

export interface Waiting {
	turn: Turn;
	/** Since when, for the agent's turn: the later of its last claim and what handed it back. */
	since?: string;
	/** What it waits on, in words. */
	why: string;
	/** How long the agent's turn may go unanswered. */
	idleAfterMs?: number;
}

const later = (a: string, b?: string) => (b && Date.parse(b) > Date.parse(a) ? b : a);
const latest = (times: string[]) => times.reduce<string | undefined>((max, t) => (!max || Date.parse(t) > Date.parse(max) ? t : max), undefined);

/** Whose turn it is on a change, and since when if it's its agent's. */
export function waitingOn(signs: ChangeSigns): Waiting {
	if (signs.asked) return { turn: "person", why: "waits on a person" };
	if (signs.landing) return { turn: "landing", why: "is being checked to land" };
	if (!signs.head) return { turn: "agent", since: signs.active, why: "has nothing pushed", idleAfterMs: BUILDING_IDLE_MS };
	const rejected = latest(signs.votes.filter((v) => v.verdict === "reject").map((v) => v.at));
	if (rejected || signs.vetoed) return { turn: "agent", since: later(signs.active, rejected), why: "had changes asked for", idleAfterMs: AGENT_TURN_IDLE_MS };
	if (signs.approved) return { turn: "agent", since: later(signs.active, latest(signs.votes.map((v) => v.at))), why: "is approved and not merged", idleAfterMs: AGENT_TURN_IDLE_MS };
	return { turn: "reviewers", why: "waits for review" };
}

/**
 * Whether a change is abandoned at `now`: its agent's turn, unanswered for
 * longer than that turn allows. Never sooner than BUILDING_IDLE_MS since its
 * agent last claimed, the floor the audit checks every stale release against.
 */
export function abandoned(signs: ChangeSigns, now: number): { abandoned: boolean; waiting: Waiting; idleMs: number } {
	const waiting = waitingOn(signs);
	const idleMs = waiting.since ? now - Date.parse(waiting.since) : 0;
	const floor = now - Date.parse(signs.active) > BUILDING_IDLE_MS;
	return { abandoned: waiting.turn === "agent" && floor && idleMs > (waiting.idleAfterMs ?? Number.POSITIVE_INFINITY), waiting, idleMs };
}
