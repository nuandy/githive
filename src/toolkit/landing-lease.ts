import type { CasLog } from "../record-log";
import { type Checking, dropLease, type Landing, type LandingState, renewLease, takeTurn } from "./landing";
import { appendRecord } from "./records";

// Who lands changes into a branch right now, as a record in Git like the
// claims, votes and review holds: the branch's lease, and the batch its
// holder is checking. Whichever merge finds the lease free or run out takes
// it by compare-and-swap, so of two at once only one does; its heartbeat
// keeps it, and it hands it on when it's done. Nothing outside Git decides
// who lands what: a merge's own turn, the records, and the branch's
// compare-and-swap do.
//
// What changes came to lately is kept in the repo's RepoCache, as a help (a
// landing is in Git as its merge commit, a failure as its rejection).
// Without the RepoCache a merge still lands: it finds out whether its change
// landed from the branch's history.

/** A branch's lease and the batch being checked, as its record keeps them. */
export interface LeaseRecord {
	lease?: { holder: string; until: number };
	checking: Checking | null;
}

const AUTHOR = "githive";
/** How many times a merge tries to hand the lease on before leaving it to run out. */
const DROP_TRIES = 3;
const empty = (): LeaseRecord => ({ checking: null });

/** Where a branch's lease is kept: this ref (branch names may hold `/`, which a ref under it can't also be). */
export const landingRef = (repo: string, branch: string) => `refs/notes/githive-landing/${repo}/${encodeURIComponent(branch)}`;

/** Which of a repo's records repos holds its branches' leases: always the first (see landingLog in env.ts). */
export const LANDING_RECORDS_REPO = 0;

/** As LandingState, for the pure lease steps in landing.ts (the outcomes they read aren't here: see gitLanding's turn). */
const asState = (record: LeaseRecord): LandingState => ({ ...(record.lease ? { lease: record.lease } : {}), checking: record.checking, recent: [] });
const asRecord = (state: LandingState): LeaseRecord => ({ ...(state.lease ? { lease: state.lease } : {}), checking: state.checking });

/**
 * A branch's landing: its lease and the batch being checked in `log` (a
 * record in Git), the rest in `kept` (the repo's RepoCache) as a help that
 * may fail. The batch being checked is kept there too, for the views that
 * show it.
 */
export function gitLanding(log: CasLog<LeaseRecord>, kept: Omit<Landing, "turn" | "renew">): Landing {
	return {
		turn: async (holder, change, head, since, ttlMs) => {
			// What it came to, if the RepoCache recalls (else, see landedAlready in merge.ts).
			const view = await kept.view().catch(() => null);
			const settled = view?.recent.findLast((s) => s.change === change && s.head === head && (s.how === "landed" || Date.parse(s.at) >= since));
			if (settled) return { settled };
			// The record busy or unreachable: not this merge's turn yet, it looks again in a moment.
			const taken = await appendRecord<LeaseRecord, "held">(log, AUTHOR, empty, (record) => {
				const turn = takeTurn(asState(record), holder, change, head, since, ttlMs);
				if (!("lease" in turn.turn) || !turn.turn.lease) return { refused: "held" };
				return { state: asRecord(turn.state), text: `${holder} lands batches${record.lease && record.lease.holder !== holder ? ` (${record.lease.holder}'s lease ran out)` : ""}` };
			}).catch((err) => {
				console.error("taking the landing lease failed", String(err));
				return { ok: false as const };
			});
			return { lease: taken.ok };
		},
		renew: async (holder, ttlMs) => {
			// Written only once less than half of it is left: each write is a push, and the holder renews at every step.
			const now = Date.now();
			const lease = (await log.read())?.commit.state.lease;
			if (lease?.holder === holder && lease.until - now > ttlMs / 2) return true;
			const renewed = await appendRecord<LeaseRecord, "lost">(log, AUTHOR, empty, (record) => {
				const kept = renewLease(asState(record), holder, ttlMs);
				return kept.held ? { state: asRecord(kept.state), text: `${holder} keeps the lease` } : { refused: "lost" };
			});
			return renewed.ok;
		},
		drop: async (holder) => {
			// Tried a few times: a lease left held keeps every waiting merge idle until it runs out.
			for (let attempt = 1; ; attempt++) {
				try {
					await appendRecord<LeaseRecord, "none">(log, AUTHOR, empty, (record) => (record.lease?.holder === holder ? { state: asRecord(dropLease(asState(record), holder)), text: `${holder} hands the lease on` } : { refused: "none" }));
					break;
				} catch (err) {
					if (attempt === DROP_TRIES) throw err;
					await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
				}
			}
			await kept.drop(holder).catch(() => undefined);
		},
		// Shown, never relied on: a batch whose showing failed is checked and lands all the same.
		checking: async (batch) => {
			await appendRecord<LeaseRecord, "none">(log, AUTHOR, empty, (record) => ({ state: { ...record, checking: batch }, text: batch ? `checking ${batch.changes.length} change(s) on ${batch.base.slice(0, 8)}` : "checking nothing" })).catch((err) =>
				console.error("recording the batch being checked failed", String(err)),
			);
			await kept.checking(batch).catch(() => undefined);
		},
		settle: (outcomes) => kept.settle(outcomes).catch((err) => console.error(`keeping ${outcomes.length} outcome(s) failed`, String(err))),
		// What's being checked as the lease record says, while its holder holds it (a holder that died checks nothing);
		// what changes came to as the RepoCache recalls.
		view: async () => {
			const [record, recalled] = await Promise.all([log.read().catch(() => undefined), kept.view().catch(() => null)]);
			const lease = record?.commit.state.lease;
			const checking = record === undefined ? (recalled?.checking ?? null) : lease && lease.until > Date.now() ? record?.commit.state.checking ?? null : null;
			return { checking, recent: recalled?.recent ?? [] };
		},
	};
}

/** Whether a merge holds the branch's lease now, as its record says. */
export async function leaseHeld(log: CasLog<LeaseRecord>, now = Date.now()) {
	const lease = (await log.read())?.commit.state.lease;
	return !!lease && lease.until > now;
}

/** A log found when it's first used (which repo holds it depends on a record read first). */
export function lazyLog<S>(find: () => Promise<CasLog<S>>): CasLog<S> & { readonly ref?: string } {
	let found: Promise<CasLog<S>> | undefined;
	let log: CasLog<S> | undefined;
	const get = async () => (log ??= await (found ??= find()));
	return {
		read: async () => (await get()).read(),
		readFresh: async () => {
			const l = await get();
			return l.readFresh ? l.readFresh() : l.read();
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
