// When a claim counts as abandoned. Time alone never does it: a claim lasts until it's released, or until another agent
// needs its paths, asks its holder whether it's still there (a challenge, see challenges.ts), and gets no answer. Only
// a change waiting on its own agent can be abandoned (nothing pushed, changes requested, or approved but not merged):
// one waiting for review, for its batch to land or for a person is waiting its turn, however long that takes.
// The module has no imports, so a dashboard can share it.

/** How long a challenged holder has to answer, by claiming again (its next call to GitHive does). */
export const CHALLENGE_WINDOW_MS = 2 * 60_000;

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
	/** When another agent asked its holder whether it's still there, if the holder hasn't answered since. */
	challenged?: string;
}

export interface Waiting {
	turn: Turn;
	why: string;
}

const latest = (times: string[]) =>
	times.reduce<string | undefined>((max, time) => (!max || Date.parse(time) > Date.parse(max) ? time : max), undefined);

export function waitingOn(signs: ChangeSigns): Waiting {
	if (signs.asked) return { turn: "person", why: "waits on a person" };
	if (signs.landing) return { turn: "landing", why: "is being checked to land" };
	if (!signs.head) return { turn: "agent", why: "has nothing pushed" };
	const rejected = latest(signs.votes.filter((v) => v.verdict === "reject").map((v) => v.at));
	if (rejected || signs.vetoed) return { turn: "agent", why: "had changes asked for" };
	if (signs.approved) return { turn: "agent", why: "is approved and not merged" };
	return { turn: "reviewers", why: "waits for review" };
}

/**
 * When the change counts as abandoned if its holder doesn't answer (its time in ms; it is abandoned after it): the
 * end of an open challenge's window, while the change waits on its agent. Undefined otherwise: then it never is.
 */
export function abandonableAt(signs: ChangeSigns): number | undefined {
	if (waitingOn(signs).turn !== "agent" || !signs.challenged) return undefined;
	return Date.parse(signs.challenged) + CHALLENGE_WINDOW_MS;
}

/** Whose turn its change is on, and while a challenge is open on its agent's turn, when the claim frees up. */
export function leaseFor(signs: ChangeSigns): { waitingOn: Turn; freeAfter?: string } {
	const freeAt = abandonableAt(signs);
	return {
		waitingOn: waitingOn(signs).turn,
		...(freeAt !== undefined ? { freeAfter: new Date(freeAt).toISOString() } : {}),
	};
}

/** Whether the claim may be freed now: on its agent's turn, challenged, and unanswered past the window. */
export function abandoned(signs: ChangeSigns, now: number): { abandoned: boolean; waiting: Waiting; why: string } {
	const waiting = waitingOn(signs);
	const at = abandonableAt(signs);
	if (waiting.turn !== "agent") return { abandoned: false, waiting, why: waiting.why };
	if (at === undefined)
		return { abandoned: false, waiting, why: "has an agent no one has asked whether it's still there" };
	if (now <= at)
		return {
			abandoned: false,
			waiting,
			why: `was asked whether it's still there, and has until ${new Date(at).toISOString()}`,
		};
	return { abandoned: true, waiting, why: `${waiting.why}, and its agent didn't answer when asked` };
}
