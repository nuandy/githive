// How many changes the server checks and lands in one batch, as src/toolkit/merge-batch.ts sizes it: about one check
// failure per batch, from the branch's recent outcomes. It has no imports, so the server's tests can hold it to the
// server's own (test/batch-size-mirror.test.ts).

/** The fewest and most changes checked and landed together. */
export const MIN_BATCH = 4;
export const MAX_BATCH = 64;
// The prior for a branch's failure rate, 1 in 20, so a new branch starts with batches of 20.
const PRIOR_FAILED = 1;
const PRIOR_OUTCOMES = 20;

/** 1/p, where p is the share of the branch's recent changes that failed, kept between MIN_BATCH and MAX_BATCH. */
export function batchSize(recent: { how: string }[]): number {
	const failed = recent.filter((settled) => settled.how === "failed").length;
	const failureRate = (failed + PRIOR_FAILED) / (recent.length + PRIOR_OUTCOMES);
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(1 / failureRate)));
}

/** A merge's batch: sized by its failures when checks run; without checks nothing fails one, so it takes all it can. */
export const batchLimit = (recent: { how: string }[], checks: string[]) =>
	checks.length ? batchSize(recent) : MAX_BATCH;
