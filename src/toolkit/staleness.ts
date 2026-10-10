// When a claim counts as abandoned. A quiet agent isn't enough: one waiting for review, for its batch to land or
// for a person is waiting its turn. Only a change waiting on its own agent can be abandoned (nothing pushed,
// changes requested, or approved but not merged), and after a while anyone may take its paths.
// The module has no imports so the dashboard can share it (web/tsconfig.json includes this file).

/** Idle limit before anything is pushed. Claiming again resets it. */
export const BUILDING_IDLE_MS = 30 * 60_000;
/** Idle limit once something is pushed and the change waits on its agent to revise or merge. */
export const AGENT_TURN_IDLE_MS = 2 * 60 * 60_000;

export type Turn = "agent" | "reviewers" | "landing" | "person";

export interface ChangeSigns {
	/** When its agent last claimed. */
	active: string;
	head: string | null;
	/** Votes on the head, without the author's own. */
	votes: { verdict: "approve" | "reject"; at: string }[];
	approved: boolean;
	/** A role that can block rejected it. */
	vetoed?: boolean;
	landing: boolean;
	/** A question to a person is pending. */
	asked: boolean;
}

export interface Waiting {
	turn: Turn;
	/** For the agent's turn: the later of its last claim and whatever handed the turn back. */
	since?: string;
	why: string;
	idleAfterMs?: number;
}

const later = (a: string, b?: string) => (b && Date.parse(b) > Date.parse(a) ? b : a);
const latest = (times: string[]) =>
	times.reduce<string | undefined>((max, time) => (!max || Date.parse(time) > Date.parse(max) ? time : max), undefined);

export function waitingOn(signs: ChangeSigns): Waiting {
	if (signs.asked) return { turn: "person", why: "waits on a person" };
	if (signs.landing) return { turn: "landing", why: "is being checked to land" };
	if (!signs.head)
		return { turn: "agent", since: signs.active, why: "has nothing pushed", idleAfterMs: BUILDING_IDLE_MS };
	const rejected = latest(signs.votes.filter((v) => v.verdict === "reject").map((v) => v.at));
	if (rejected || signs.vetoed)
		return {
			turn: "agent",
			since: later(signs.active, rejected),
			why: "had changes asked for",
			idleAfterMs: AGENT_TURN_IDLE_MS,
		};
	if (signs.approved)
		return {
			turn: "agent",
			since: later(signs.active, latest(signs.votes.map((v) => v.at))),
			why: "is approved and not merged",
			idleAfterMs: AGENT_TURN_IDLE_MS,
		};
	return { turn: "reviewers", why: "waits for review" };
}

/**
 * Whether the agent's turn has gone unanswered longer than allowed. Never sooner than BUILDING_IDLE_MS after its
 * last claim, the floor the audit checks every stale release against.
 */
export function abandoned(signs: ChangeSigns, now: number): { abandoned: boolean; waiting: Waiting; idleMs: number } {
	const waiting = waitingOn(signs);
	const idleMs = waiting.since ? now - Date.parse(waiting.since) : 0;
	const floor = now - Date.parse(signs.active) > BUILDING_IDLE_MS;
	return {
		abandoned: waiting.turn === "agent" && floor && idleMs > (waiting.idleAfterMs ?? Number.POSITIVE_INFINITY),
		waiting,
		idleMs,
	};
}
