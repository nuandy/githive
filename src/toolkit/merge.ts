import { type Landing, memoryLanding } from "./landing";
import { landBatch } from "./merge-batch";
import { holdLease, LEASE_MS } from "./merge-lease";
import { landedAlready, outcomeOf, readyNow } from "./merge-ready";
import type { MergeInput, MergeOutcome } from "./merge-types";

// The toolkit's merge for a cooperative agent. It checks the conventions the agent follows (its claim covers what it
// changed, its head has the approvals, it merges cleanly and the checks pass) and refuses to help break them. It binds
// no one: an agent can merge with plain git, and the audit sees the same records.
//
// Claims keep changes off each other's paths, so ready changes land as a set rather than in a line. The merge holding
// the branch's lease (see landing-lease.ts) checks every ready change together on main and lands them in one push, so
// main only ever holds checked code. A failing batch is split until the failing change is found and put out. The git
// work runs in the repo's Gate (see BatchGit). docs/design.md, "Landing", has the details.
//
// The work is split by concern: merge-ready.ts decides whether one change may land, merge-batch.ts gathers and lands a
// batch, merge-checks.ts checks it and searches for the failing change, and merge-lease.ts keeps the lease alive.

export type {
	BatchChange,
	BatchGit,
	BatchSource,
	Candidate,
	CheckResult,
	CheckRunner,
	Inspected,
	MergeInput,
	MergeOutcome,
} from "./merge-types";
export { atMost, batchSize, MAX_BATCH, MIN_BATCH } from "./merge-batch";
export { CHECKS_REVIEWER } from "./merge-checks";
export { LEASE_MS, LEASE_TTL_MS } from "./merge-lease";

const POLL_MS = 3_000;
/**
 * How long a merge waits before answering "still waiting", and how long a lease holder goes on starting batches.
 * Cloudflare drops a request held open too long, so every answer comes well before that.
 */
export const ANSWER_WITHIN_MS = 10 * 60_000;
// How many batches a lease holder lands before handing the lease on, if its own change hasn't settled.
const ROUNDS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lands `changes/<change>` together with every other ready change, then releases their claims. Returns once this
 * change has landed, been put out or stopped being ready. Until then it waits while another merge holds the lease.
 */
export async function mergeChange(input: MergeInput): Promise<MergeOutcome> {
	const landing = input.landing ?? memoryLanding();
	const holder = crypto.randomUUID();
	const started = Date.now();
	// Refuse at once if it isn't ready, so the agent can act, unless it has landed already.
	const mine = await readyNow(input, landing);
	if (!mine.ok) return (await landedAlready(input, landing, mine.head)) ?? mine.refused;
	const head = mine.ready.head;
	const answerBy = started + (input.answerWithinMs ?? ANSWER_WITHIN_MS);
	for (;;) {
		const turn = await landing.turn(holder, input.change, head, started, LEASE_MS);
		if ("settled" in turn) return outcomeOf(turn.settled);
		if (turn.lease) {
			const outcome = await landWhileHeld(input, landing, holder, answerBy, head);
			// It may have stopped being ready because another batch landed it and released its claim.
			if (outcome && !outcome.ok) return (await landedAlready(input, landing, head)) ?? outcome;
			if (outcome) return outcome;
		}
		// Answer before Cloudflare drops the request for being held open too long.
		if (Date.now() >= answerBy) return stillWaiting(input.change, head, Date.now() - started);
		if (!turn.lease) await sleep(input.pollMs ?? POLL_MS);
	}
}

// Not a refusal. Merging the same commit again keeps waiting, and answers with the merge commit once it lands.
function stillWaiting(change: string, head: string, waitedMs: number): MergeOutcome {
	return {
		ok: false,
		pending: true,
		reasons: [
			`${change} is ready and waiting to land (${head.slice(0, 8)}): others' batches came first in ` +
				`the ${Math.round(waitedMs / 60_000)} minutes this merge waited. Call merge again to go on ` +
				"waiting; it lands with a coming batch.",
		],
	};
}

// Lands batches until this merge's own change settles, for at most ROUNDS batches and none started after `answerBy`.
// Null if the change hasn't settled by then or the lease was lost.
async function landWhileHeld(
	input: MergeInput,
	landing: Landing,
	holder: string,
	answerBy: number,
	head: string,
): Promise<MergeOutcome | null> {
	const lease = holdLease(input, landing, holder);
	const { holding } = lease;
	// Claims are released after the lease is handed on, because a write per change would hold up the next batch.
	const releases: (() => Promise<void>)[] = [];
	try {
		// A batch takes minutes, so none starts once this merge should be answering. A waiting merge takes the lease.
		for (let round = 0; round < ROUNDS && holding.held && Date.now() < answerBy; round++) {
			const done = await landBatch(input, landing, holding, head);
			if (!done.ok) return done;
			releases.push(done.release);
			const mine = done.settled.find((settled) => settled.change === input.change);
			if (mine) return outcomeOf(mine);
		}
		return null;
	} finally {
		lease.stop();
		await landing.drop(holder).catch(() => undefined);
		for (const release of releases) await release();
	}
}
