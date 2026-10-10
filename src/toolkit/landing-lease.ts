import type { CasLog } from "../record-log";
import { type Checking, dropLease, type Landing, type LandingState, renewLease, takeTurn } from "./landing";
import { appendRecord } from "./records";

// Who lands changes into a branch right now. Like the claims and votes, this is a record in Git: the branch's
// lease and the batch its holder is checking. A merge that finds the lease free or expired takes it by
// compare-and-swap, renews it while it works and hands it on when done, so nothing outside Git decides who lands.
//
// Recent outcomes are cached in the repo's RepoCache. Without the cache a merge still lands, and it learns
// whether its change landed from the branch's history.

export interface LeaseRecord {
	lease?: { holder: string; until: number };
	checking: Checking | null;
}

const AUTHOR = "githive";
const DROP_TRIES = 3;
const empty = (): LeaseRecord => ({ checking: null });

/** One ref per branch. The name is encoded because a branch name may contain `/`. */
export const landingRef = (repo: string, branch: string) =>
	`refs/notes/githive-landing/${repo}/${encodeURIComponent(branch)}`;

/** Leases always live in a repo's first records repo (see landingLog in env.ts). */
export const LANDING_RECORDS_REPO = 0;

// Converts between the record and LandingState for the pure lease steps in landing.ts.
const asState = (record: LeaseRecord): LandingState => ({
	...(record.lease ? { lease: record.lease } : {}),
	checking: record.checking,
	recent: [],
});
const asRecord = (state: LandingState): LeaseRecord => ({
	...(state.lease ? { lease: state.lease } : {}),
	checking: state.checking,
});

/**
 * A branch's landing. The lease and the batch being checked live in `log`. Recent outcomes, and a copy of the
 * batch for views, live in `kept`, the repo's RepoCache, which is allowed to fail.
 */
export function gitLanding(log: CasLog<LeaseRecord>, kept: Omit<Landing, "turn" | "renew">): Landing {
	return {
		turn: async (holder, change, head, since, ttlMs) => {
			// The cache may already know how this change came out (otherwise see landedAlready in merge.ts).
			const view = await kept.view().catch(() => null);
			const settled = view?.recent.findLast(
				(outcome) =>
					outcome.change === change &&
					outcome.head === head &&
					(outcome.how === "landed" || Date.parse(outcome.at) >= since),
			);
			if (settled) return { settled };
			// If the record is busy or unreachable, the merge doesn't get its turn yet and tries again shortly.
			const taken = await appendRecord<LeaseRecord, "held">(log, AUTHOR, empty, (record) => {
				const turn = takeTurn(asState(record), holder, change, head, since, ttlMs);
				if (!("lease" in turn.turn) || !turn.turn.lease) return { refused: "held" };
				const lapsed =
					record.lease && record.lease.holder !== holder ? ` (${record.lease.holder}'s lease ran out)` : "";
				return { state: asRecord(turn.state), text: `${holder} lands batches${lapsed}` };
			}).catch((err) => {
				console.error("taking the landing lease failed", String(err));
				return { ok: false as const };
			});
			return { lease: taken.ok };
		},
		renew: async (holder, ttlMs) => {
			// Each write is a push and the holder renews at every step, so write only once less than half the
			// lease is left.
			const now = Date.now();
			const lease = (await log.read())?.commit.state.lease;
			if (lease?.holder === holder && lease.until - now > ttlMs / 2) return true;
			const renewed = await appendRecord<LeaseRecord, "lost">(log, AUTHOR, empty, (record) => {
				const renewal = renewLease(asState(record), holder, ttlMs);
				if (!renewal.held) return { refused: "lost" };
				return { state: asRecord(renewal.state), text: `${holder} keeps the lease` };
			});
			return renewed.ok;
		},
		drop: async (holder) => {
			// Retry, because a lease left held keeps every waiting merge idle until it expires.
			for (let attempt = 1; ; attempt++) {
				try {
					await appendRecord<LeaseRecord, "none">(log, AUTHOR, empty, (record) => {
						if (record.lease?.holder !== holder) return { refused: "none" };
						return { state: asRecord(dropLease(asState(record), holder)), text: `${holder} hands the lease on` };
					});
					break;
				} catch (err) {
					if (attempt === DROP_TRIES) throw err;
					await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
				}
			}
			await kept.drop(holder).catch(() => undefined);
		},
		// For display only. A batch is checked and lands even if recording it fails.
		checking: async (batch) => {
			await appendRecord<LeaseRecord, "none">(log, AUTHOR, empty, (record) => ({
				state: { ...record, checking: batch },
				text: batch ? `checking ${batch.changes.length} change(s) on ${batch.base.slice(0, 8)}` : "checking nothing",
			})).catch((err) => console.error("recording the batch being checked failed", String(err)));
			await kept.checking(batch).catch(() => undefined);
		},
		settle: (outcomes) =>
			kept.settle(outcomes).catch((err) => console.error(`keeping ${outcomes.length} outcome(s) failed`, String(err))),
		// Trust the record's batch only while its lease is live, since a holder that died checks nothing.
		view: async () => {
			const [record, recalled] = await Promise.all([log.read().catch(() => undefined), kept.view().catch(() => null)]);
			const recent = recalled?.recent ?? [];
			if (record === undefined) return { checking: recalled?.checking ?? null, recent };
			const lease = record?.commit.state.lease;
			const live = lease && lease.until > Date.now();
			return { checking: live ? (record?.commit.state.checking ?? null) : null, recent };
		},
	};
}

/** Whether a merge holds the branch's lease now. */
export async function leaseHeld(log: CasLog<LeaseRecord>, now = Date.now()) {
	const lease = (await log.read())?.commit.state.lease;
	return !!lease && lease.until > now;
}

/** A log resolved on first use, since which repo holds it depends on reading another record first. */
export function lazyLog<S>(find: () => Promise<CasLog<S>>): CasLog<S> & { readonly ref?: string } {
	let found: Promise<CasLog<S>> | undefined;
	let log: CasLog<S> | undefined;
	const get = async () => (log ??= await (found ??= find()));
	return {
		read: async () => (await get()).read(),
		readFresh: async () => {
			const resolved = await get();
			return resolved.readFresh ? resolved.readFresh() : resolved.read();
		},
		append: async (parent, commit) => (await get()).append(parent, commit),
		get lastRefusal() {
			return log?.lastRefusal ?? null;
		},
		get ref() {
			return (log as { ref?: string } | undefined)?.ref;
		},
	};
}
