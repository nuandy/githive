import type { CasLog } from "../record-log";
import { appendRecord } from "./records";
import { CHALLENGE_WINDOW_MS } from "./staleness";

// Challenges (see docs/design.md, "Claims"). An agent whose claim a held claim refuses asks the holder whether it's
// still there. The question is a record in Git, so a release that follows can cite it and the audit can check it; the
// doorbell only carries it to the holder. The holder answers by claiming again, which its next call to GitHive does
// for it. A claim no one challenges never lapses.

export { CHALLENGE_WINDOW_MS };

/** One question to a claim's holder: who asked, and when. */
export interface ChallengeRecord {
	change: string;
	holder: string;
	/** The agent that asked. */
	by: string;
	at: string;
}

export interface Challenges {
	challenges: ChallengeRecord[];
}

/** How long a challenge is kept: long after anyone could act on it. */
const KEPT_MS = 24 * 60 * 60_000;

export const challengesRef = (repo: string) => `refs/notes/githive-challenges/${repo}`;

const empty = (): Challenges => ({ challenges: [] });

/**
 * The challenge to `claim` its holder hasn't answered: one made after the holder last claimed. Claiming again is the
 * answer, so a challenge from before the holder's last claim has been answered.
 */
export function openChallenge(
	state: Challenges | undefined,
	claim: { change: string; agent: string; active: string },
): ChallengeRecord | undefined {
	const asked = (state?.challenges ?? []).filter((each) => each.change === claim.change && each.holder === claim.agent);
	const latest = asked.at(-1);
	return latest && Date.parse(latest.at) > Date.parse(claim.active) ? latest : undefined;
}

/** When a challenge's holder must answer by: after that, its claim may be freed if its change is on its turn. */
export const answerBy = (challenge: ChallengeRecord) => new Date(Date.parse(challenge.at) + CHALLENGE_WINDOW_MS);

/**
 * Asks `claim`'s holder whether it's still there, unless a question is already open. Answers with the open challenge,
 * and whether this call opened it.
 */
export async function challenge(
	log: CasLog<Challenges>,
	claim: { change: string; agent: string; active: string },
	by: string,
	now = Date.now(),
): Promise<{ challenge: ChallengeRecord; opened: boolean }> {
	let open: ChallengeRecord | undefined;
	const outcome = await appendRecord<Challenges, ChallengeRecord>(log, by, empty, (state) => {
		const before = openChallenge(state, claim);
		if (before) return { refused: before };
		const asked: ChallengeRecord = { change: claim.change, holder: claim.agent, by, at: new Date(now).toISOString() };
		open = asked;
		const kept = state.challenges.filter((each) => now - Date.parse(each.at) < KEPT_MS && each.change !== claim.change);
		return {
			state: { challenges: [...kept, asked] },
			text: `${by} asks ${claim.agent} whether it's still working on ${claim.change}`,
		};
	});
	return outcome.ok ? { challenge: open!, opened: true } : { challenge: outcome.refused, opened: false };
}
