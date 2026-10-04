import type { CasLog, LogCommit } from "../election";

// The coordinator-free records (claims, votes) are append-only logs in Git.
// An author reads the tip, works out the next state itself, and appends on
// that tip; the append is compare-and-swap, so a concurrent author's entry
// makes it read again and redo its check.

const ATTEMPTS = 5;

/**
 * Append to a record on the tip `next` was computed from. `next` returns the
 * new state and a line saying what happened, or a refusal (anything else),
 * which is returned as is. Retries when another author's append got there first.
 */
export async function appendRecord<S, Refusal>(
	log: CasLog<S>,
	author: string,
	empty: () => S,
	next: (state: S) => { state: S; text: string } | { refused: Refusal },
): Promise<{ ok: true; tip: string } | { ok: false; refused: Refusal }> {
	for (let attempt = 1; ; attempt++) {
		const head = await log.read();
		const outcome = next(head?.commit.state ?? empty());
		if ("refused" in outcome) return { ok: false, refused: outcome.refused };
		const commit: LogCommit<S> = {
			term: 0,
			leader: author,
			leaseUntil: 0,
			kind: "decisions",
			entries: [{ commit: "none", text: outcome.text, at: new Date().toISOString() }],
			state: outcome.state,
			batch: crypto.randomUUID(),
		};
		const tip = await log.append(head?.tip ?? null, commit);
		if (tip) return { ok: true, tip };
		if (attempt === ATTEMPTS) throw new Error("[503] the record kept moving; try again");
	}
}
