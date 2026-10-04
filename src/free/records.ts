import type { CasLog, LogCommit } from "../election";

// The coordinator-free records (claims, votes) are append-only logs in Git.
// An author reads the tip, works out the next state itself, and appends on
// that tip; the append is compare-and-swap, so a concurrent author's entry
// makes it read again and redo its check.

// Under load every claim, release and refresh contends for the one ref: keep
// trying, with random, growing backoff so the losers don't collide again.
const ATTEMPTS = 12;
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25 * 2 ** attempt, 1_000)));

type Next<S, Refusal> = (state: S) => { state: S; text: string } | { refused: Refusal } | Promise<{ state: S; text: string } | { refused: Refusal }>;
type Outcome<Refusal> = { ok: true; tip: string } | { ok: false; refused: Refusal };

interface Pending<S> {
	author: string;
	empty: () => S;
	next: Next<S, unknown>;
	resolve: (outcome: Outcome<unknown>) => void;
	reject: (err: unknown) => void;
}

/**
 * Appends waiting on each log object. Appends to the same log that arrive
 * while one is being pushed go out together in the next push: under load that
 * is one compare-and-swap instead of one each, all contending for the same ref.
 * (Logs shared across calls, as the Worker's are, batch across calls.)
 */
const queues = new WeakMap<CasLog<unknown>, { items: Pending<unknown>[]; flushing: boolean }>();

/**
 * Append to a record on the tip `next` was computed from. `next` returns the
 * new state and a line saying what happened, or a refusal (anything else),
 * which is returned as is. Retries when another author's append got there first.
 * Appends batched together are each checked, in order, against the state the
 * ones before them made, and each is answered as if it had gone alone.
 */
export function appendRecord<S, Refusal>(log: CasLog<S>, author: string, empty: () => S, next: Next<S, Refusal>): Promise<Outcome<Refusal>> {
	return new Promise((resolve, reject) => {
		const key = log as CasLog<unknown>;
		let queue = queues.get(key);
		if (!queue) queues.set(key, (queue = { items: [], flushing: false }));
		queue.items.push({ author, empty, next, resolve, reject } as unknown as Pending<unknown>);
		if (!queue.flushing) {
			queue.flushing = true;
			void flush(key, queue);
		}
	});
}

async function flush(log: CasLog<unknown>, queue: { items: Pending<unknown>[]; flushing: boolean }) {
	// The flag is cleared in the same synchronous step that finds the queue
	// empty, so an append queued after that always starts a new flush.
	try {
		while (queue.items.length) await commitBatch(log, queue.items.splice(0));
	} finally {
		queue.flushing = false;
	}
}

/** Check each append in order on the tip, push them as one commit, and answer each; on a lost compare-and-swap, check them all again on the new tip. */
async function commitBatch<S>(log: CasLog<S>, batch: Pending<S>[]) {
	try {
		for (let attempt = 1; ; attempt++) {
			const head = await log.read();
			let state = head?.commit.state ?? batch[0].empty();
			const accepted: Pending<S>[] = [];
			const refused: [Pending<S>, unknown][] = [];
			const entries: LogCommit<S>["entries"] = [];
			for (const item of [...batch]) {
				try {
					const outcome = await item.next(state);
					if ("refused" in outcome) refused.push([item, outcome.refused]);
					else {
						state = outcome.state;
						accepted.push(item);
						entries.push({ commit: "none", text: outcome.text, at: new Date().toISOString() });
					}
				} catch (err) {
					// Its own failure; the others go on without it.
					item.reject(err);
					batch.splice(batch.indexOf(item), 1);
				}
			}
			const answerRefusals = () => refused.forEach(([item, why]) => item.resolve({ ok: false, refused: why }));
			if (!accepted.length) return answerRefusals();
			const commit: LogCommit<S> = {
				term: 0,
				leader: [...new Set(accepted.map((item) => item.author))].join(", "),
				leaseUntil: 0,
				kind: "decisions",
				entries,
				state,
				batch: crypto.randomUUID(),
			};
			const tip = await log.append(head?.tip ?? null, commit);
			if (tip) {
				answerRefusals();
				for (const item of accepted) item.resolve({ ok: true, tip });
				return;
			}
			if (attempt === ATTEMPTS) {
				answerRefusals();
				for (const item of accepted) item.reject(new Error("[503] the record kept moving; try again"));
				return;
			}
			await backoff(attempt);
		}
	} catch (err) {
		// Reading or pushing failed: every append still waiting fails with it.
		for (const item of batch) item.reject(err);
	}
}
