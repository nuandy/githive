import type { CheckResult } from "./merge";

// Who lands changes into a branch right now, and what each change came to.
// There's no line: a change is ready to land once it's approved (the votes
// say so), and the merge that takes the lease lands every ready change into
// the branch at once, checked together (see mergeChange). The lease only
// keeps two merges from checking the same changes side by side: what keeps
// the branch right is its compare-and-swap, and the audit. Live, it's kept in
// the repo's RepoCache (see repo-cache.ts); losing it costs a merge checking
// again, nothing more.

/** What a change's head came to. */
export interface Settled {
	change: string;
	head: string;
	agent: string;
	how: "landed" | "failed";
	at: string;
	/** Its merge commit, landed. */
	commit?: string;
	/** Landed without checks: it only touched what they skip. */
	skipped?: boolean;
	/** Why it didn't land, failed. */
	reasons?: string[];
	checks?: CheckResult[];
}

/** The changes being checked together now, on `base`. */
export interface Checking {
	base: string;
	since: string;
	changes: { change: string; head: string; agent: string }[];
}

export interface LandingView {
	checking: Checking | null;
	/** The changes settled last, newest last. */
	recent: Settled[];
}

/** One branch's landing. */
export interface Landing {
	/**
	 * What `change` at `head` came to, if it's settled (landed, or failed since
	 * `since`: merging again checks again); else whether `holder` holds the
	 * lease now (taking it if it's free or ran out).
	 */
	turn(holder: string, change: string, head: string, since: number, ttlMs: number): Promise<{ settled: Settled } | { lease: boolean }>;
	/** Keep the lease a while longer; false if it isn't `holder`'s any more. */
	renew(holder: string, ttlMs: number): Promise<boolean>;
	drop(holder: string): Promise<void>;
	/** Show what's being checked now (null: nothing). */
	checking(batch: Checking | null): Promise<void>;
	settle(outcomes: Settled[]): Promise<void>;
	view(): Promise<LandingView>;
}

/** How many settled changes are kept: enough for a merge waiting on a batch to find its own. */
export const RECENT_KEPT = 200;

/** A branch's landing as data, for RepoCache and memoryLanding to keep alike. */
export interface LandingState {
	lease?: { holder: string; until: number };
	checking: Checking | null;
	recent: Settled[];
}

export const emptyLanding = (): LandingState => ({ checking: null, recent: [] });

export function takeTurn(state: LandingState, holder: string, change: string, head: string, since: number, ttlMs: number, now = Date.now()): { state: LandingState; turn: { settled: Settled } | { lease: boolean } } {
	const settled = state.recent.findLast((s) => s.change === change && s.head === head && (s.how === "landed" || Date.parse(s.at) >= since));
	if (settled) return { state, turn: { settled } };
	const { lease } = state;
	if (lease && lease.holder !== holder && lease.until > now) return { state, turn: { lease: false } };
	// A lease that ran out was its holder's last batch: what it showed as checking isn't any more.
	const checking = lease && lease.holder !== holder ? null : state.checking;
	return { state: { ...state, checking, lease: { holder, until: now + ttlMs } }, turn: { lease: true } };
}

/** Keep the lease `ttlMs` more, never less than it has: steps running side by side (a search, a landing) each keep it as long as they need. */
export function renewLease(state: LandingState, holder: string, ttlMs: number, now = Date.now()): { state: LandingState; held: boolean } {
	if (state.lease?.holder !== holder) return { state, held: false };
	return { state: { ...state, lease: { holder, until: Math.max(state.lease.until, now + ttlMs) } }, held: true };
}

export const dropLease = (state: LandingState, holder: string): LandingState => (state.lease?.holder === holder ? { ...state, lease: undefined, checking: null } : state);

export const settleOutcomes = (state: LandingState, outcomes: Settled[]): LandingState => ({ ...state, recent: [...state.recent, ...outcomes].slice(-RECENT_KEPT) });

/** One branch's landing kept in memory: in tests, and wherever no RepoCache keeps it (then only merges in this isolate share it). */
export function memoryLanding(): Landing {
	let state = emptyLanding();
	return {
		turn: async (holder, change, head, since, ttlMs) => {
			const taken = takeTurn(state, holder, change, head, since, ttlMs);
			state = taken.state;
			return taken.turn;
		},
		renew: async (holder, ttlMs) => {
			const renewed = renewLease(state, holder, ttlMs);
			state = renewed.state;
			return renewed.held;
		},
		drop: async (holder) => {
			state = dropLease(state, holder);
		},
		checking: async (batch) => {
			state = { ...state, checking: batch };
		},
		settle: async (outcomes) => {
			state = settleOutcomes(state, outcomes);
		},
		view: async () => ({ checking: state.checking, recent: state.recent }),
	};
}
