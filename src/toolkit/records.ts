import type { CasLog, LogCommit } from "../record-log";

// The records (claims, votes) are append-only logs in Git. An author reads the tip, computes the next state and
// appends with compare-and-swap, so a concurrent append makes it read and check again.

// Under load every claim, release and refresh contends for one ref. Random, growing backoff keeps the losers
// from colliding again.
const ATTEMPTS = 12;
const backoff = (attempt: number) =>
	new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25 * 2 ** attempt, 1_000)));

/**
 * Appends the state `next` computes from the current tip, retrying when another author appended first.
 * A refusal from `next` is returned as is.
 */
export async function appendRecord<S, Refusal>(
	log: CasLog<S>,
	author: string,
	empty: () => S,
	next: (
		state: S,
	) => { state: S; text: string } | { refused: Refusal } | Promise<{ state: S; text: string } | { refused: Refusal }>,
): Promise<{ ok: true; tip: string } | { ok: false; refused: Refusal }> {
	for (let attempt = 1; ; attempt++) {
		const head = await log.read();
		const outcome = await next(head?.commit.state ?? empty());
		if ("refused" in outcome) return { ok: false, refused: outcome.refused };
		const commit: LogCommit<S> = {
			author,
			kind: "decisions",
			entries: [{ commit: "none", text: outcome.text, at: new Date().toISOString() }],
			state: outcome.state,
			batch: crypto.randomUUID(),
		};
		const tip = await log.append(head?.tip ?? null, commit);
		if (tip) return { ok: true, tip };
		if (attempt === ATTEMPTS) {
			const ref = (log as { ref?: string }).ref;
			const which = ref ? ` (${ref})` : "";
			throw new Error(
				log.lastRefusal === "busy"
					? `[503] the Git server stayed busy${which}; try again`
					: `[503] the record kept moving${which}; try again`,
			);
		}
		await backoff(attempt);
	}
}
