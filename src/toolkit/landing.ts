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
	/** Landed: the files it changed (the first LANDED_FILES_KEPT, and how many more) and its intent, for the news told to
	 * other agents and for saying who last changed a file a merge conflicts on. */
	files?: string[];
	filesMore?: number;
	intent?: string;
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

/**
 * The next batch's changes, read ahead while a batch was checked: each one's
 * head and the files it changed since it left `base`. The merge that lands
 * the next batch reuses a change's read when its head is still the one it
 * last saw, and reads the rest; it validates every change against the
 * records, and checks the batch on the main it lands on, as ever.
 */
export interface Ahead {
	base: string;
	at: string;
	read: { change: string; head: string; files: string[] }[];
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
	/** Whether `heads`, merged onto `base` in this order, passed the checks already: then the same code needn't be checked again. */
	passed(base: string, heads: string[]): Promise<boolean>;
	/** `heads` merged onto `base` in this order passed the checks. */
	checked(base: string, heads: string[]): Promise<void>;
	/** Keep the next batch's changes as read ahead (see Ahead), in place of any read before. */
	keepAhead(ahead: Ahead): Promise<void>;
	/** The next batch's changes as read ahead last, if any. */
	ahead(): Promise<Ahead | null>;
}

/** How many settled changes are kept: enough for a merge waiting on a batch to find its own. */
export const RECENT_KEPT = 200;
/** How many of a landed change's files its outcome keeps, and how much of its intent: 200 outcomes stay a small record. */
export const LANDED_FILES_KEPT = 12;
export const LANDED_INTENT_CHARS = 140;

/** A change landed lately, as told to other agents (news) and when a merge conflicts on its files. */
export interface Landed {
	change: string;
	agent: string;
	commit?: string;
	at: string;
	files: string[];
	filesMore?: number;
	intent?: string;
}

/** Outcomes that landed, as news: what changed, by whom, and why. */
export const asNews = (outcomes: Settled[]): Landed[] =>
	outcomes.filter((s) => s.how === "landed").map((s) => ({ change: s.change, agent: s.agent, at: s.at, files: s.files ?? [], ...(s.commit ? { commit: s.commit } : {}), ...(s.filesMore ? { filesMore: s.filesMore } : {}), ...(s.intent ? { intent: s.intent } : {}) }));

/** For each of `files`, the change that last landed on it, as the landing recalls: who to ask about a conflict there. */
export const lastLandedOn = (outcomes: Settled[], files: string[]) =>
	files.flatMap((file) => {
		const last = asNews(outcomes).findLast((l) => l.files.includes(file));
		return last ? [{ file, change: last.change, agent: last.agent, ...(last.commit ? { commit: last.commit } : {}), ...(last.intent ? { intent: last.intent } : {}) }] : [];
	});

/** A conflict's causes in words: `a.ts (changed by note-7, agent-3: "add refunds", 2f56723d)`. */
export const conflictWords = (files: string[], causes: ReturnType<typeof lastLandedOn>) =>
	files.map((file) => {
		const c = causes.find((x) => x.file === file);
		return c ? `${file} (changed by ${c.change}, ${c.agent}${c.intent ? `: "${c.intent}"` : ""}${c.commit ? `, ${c.commit.slice(0, 8)}` : ""})` : file;
	});

/** A branch's landing as data, for RepoCache and memoryLanding to keep alike. */
export interface LandingState {
	lease?: { holder: string; until: number };
	checking: Checking | null;
	recent: Settled[];
	/**
	 * Batches (and parts of them) that passed the checks lately: a main, and
	 * the changes merged onto it in order. A batch whose merge went away before
	 * it landed (Cloudflare dropped it, say) is checked again by the next merge
	 * on the same code; this spares that.
	 */
	passed?: { base: string; heads: string; at: string }[];
	/** The next batch's changes, read ahead (see Ahead). */
	ahead?: Ahead;
}

/** How many passed checks are kept. */
export const PASSED_KEPT = 100;

export const wasChecked = (state: LandingState, base: string, heads: string[]) => !!state.passed?.some((p) => p.base === base && p.heads === heads.join(" "));

export const markChecked = (state: LandingState, base: string, heads: string[], now = new Date()): LandingState =>
	wasChecked(state, base, heads) ? state : { ...state, passed: [...(state.passed ?? []), { base, heads: heads.join(" "), at: now.toISOString() }].slice(-PASSED_KEPT) };

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
		passed: async (base, heads) => wasChecked(state, base, heads),
		checked: async (base, heads) => {
			state = markChecked(state, base, heads);
		},
		keepAhead: async (ahead) => {
			state = { ...state, ahead };
		},
		ahead: async () => state.ahead ?? null,
	};
}
