import type { TouchedBy } from "./batch-reads";
import type { CheckResult } from "./merge";

// Who lands changes into a branch right now, and how each change settled. There is no queue: the merge that takes
// the lease lands every approved change at once, checked together (see mergeChange). The lease only keeps two
// merges from checking the same changes in parallel; the branch's compare-and-swap and the audit keep it correct.
// The lease is a record in Git (landing-lease.ts) and outcomes are cached in the RepoCache, where losing them
// only costs a re-check. memoryLanding keeps everything in memory for tests.

/** How a change's head settled. */
export interface Settled {
	change: string;
	head: string;
	agent: string;
	how: "landed" | "failed";
	at: string;
	commit?: string;
	/** If it landed: its first files and intent, for news to agents and for naming who changed a conflicting file. */
	files?: string[];
	filesMore?: number;
	intent?: string;
	/** Landed without checks because it only touched files they skip. */
	skipped?: boolean;
	reasons?: string[];
	checks?: CheckResult[];
	/** If it failed because it doesn't merge onto the branch: its files, and who changed them (see putOut). */
	conflicts?: string[];
	touchedBy?: TouchedBy[];
}

/** The changes being checked together now, on `base`. */
export interface Checking {
	base: string;
	since: string;
	changes: { change: string; head: string; agent: string }[];
}

export interface LandingView {
	checking: Checking | null;
	/** Recently settled changes, newest last. */
	recent: Settled[];
}

export interface Landing {
	/**
	 * The outcome for `change` at `head` if it settled; a failure counts only after `since`, so merging again
	 * re-checks. Otherwise whether `holder` now holds the lease, taking it if it's free or expired.
	 */
	turn(
		holder: string,
		change: string,
		head: string,
		since: number,
		ttlMs: number,
	): Promise<{ settled: Settled } | { lease: boolean }>;
	/** Extends the lease. False if `holder` no longer has it. */
	renew(holder: string, ttlMs: number): Promise<boolean>;
	drop(holder: string): Promise<void>;
	checking(batch: Checking | null): Promise<void>;
	settle(outcomes: Settled[]): Promise<void>;
	view(): Promise<LandingView>;
}

/** Enough settled changes for a merge waiting on a batch to find its own. */
export const RECENT_KEPT = 200;
/** Caps on a landed change's files and intent, so the recent outcomes stay a small record. */
export const LANDED_FILES_KEPT = 12;
export const LANDED_INTENT_CHARS = 140;

/** A recently landed change, as shown to other agents and named when a merge conflicts on its files. */
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
	outcomes.filter((outcome) => outcome.how === "landed").map(newsOf);

function newsOf(outcome: Settled): Landed {
	const news: Landed = { change: outcome.change, agent: outcome.agent, at: outcome.at, files: outcome.files ?? [] };
	if (outcome.commit) news.commit = outcome.commit;
	if (outcome.filesMore) news.filesMore = outcome.filesMore;
	if (outcome.intent) news.intent = outcome.intent;
	return news;
}

/** For each file, the change that last landed on it, so agents know who to ask about a conflict there. */
export const lastLandedOn = (outcomes: Settled[], files: string[]) =>
	files.flatMap((file) => {
		const last = asNews(outcomes).findLast((landed) => landed.files.includes(file));
		if (!last) return [];
		return [
			{
				file,
				change: last.change,
				agent: last.agent,
				...(last.commit ? { commit: last.commit } : {}),
				...(last.intent ? { intent: last.intent } : {}),
			},
		];
	});

/**
 * A conflict's causes in words: `a.ts (changed by note-7, agent-3: "add refunds", 2f56723d)`. A file no recent
 * landing names is named by the newest commit in `touchedBy`, such as one pushed with plain git:
 * `a.ts (changed by bob in 2f56723d: "fix typo")`.
 */
export const conflictWords = (files: string[], causes: ReturnType<typeof lastLandedOn>, touchedBy: TouchedBy[] = []) =>
	files.map((file) => {
		const cause = causes.find((candidate) => candidate.file === file);
		const touched = touchedBy.find((candidate) => candidate.file === file);
		const by = cause ?? touched;
		if (!by) return file;
		const commit = by.commit ? `, ${by.commit.slice(0, 8)}` : "";
		const intent = by.intent ? `: "${by.intent}"` : "";
		if (!by.change) return `${file} (changed by ${touched?.author} in ${by.commit?.slice(0, 8)}${intent})`;
		return `${file} (changed by ${by.change}${by.agent ? `, ${by.agent}` : ""}${intent}${commit})`;
	});

/** How a conflict's line starts (see conflictLine), so a rejection that tells of one can be told from failed checks. */
export const CONFLICT_ON = "conflict on ";

/**
 * A conflict as one line, for the change's attempts and its merge commit's story, naming each file's newest change:
 * `conflict on src/billing/invoice.ts with c-7 by alice ("add partial refunds", 6584265)`. A commit pushed with
 * plain git is named by its commit and author.
 */
export function conflictLine(files: string[], touchedBy: TouchedBy[], causes: ReturnType<typeof lastLandedOn> = []) {
	const named = files.map((file) => {
		const touched = touchedBy.find((candidate) => candidate.file === file);
		const by = touched ?? causes.find((candidate) => candidate.file === file);
		if (!by) return file;
		const commit = by.commit?.slice(0, 7);
		if (!by.change) return `${file} with ${commit} by ${touched?.author}${by.intent ? ` ("${by.intent}")` : ""}`;
		const why = [by.intent ? `"${by.intent}"` : "", commit ?? ""].filter(Boolean).join(", ");
		return `${file} with ${by.change}${by.agent ? ` by ${by.agent}` : ""}${why ? ` (${why})` : ""}`;
	});
	return `${CONFLICT_ON}${named.join("; ")}`;
}

/** A branch's landing as plain data, shared by RepoCache and memoryLanding. */
export interface LandingState {
	lease?: { holder: string; until: number };
	checking: Checking | null;
	recent: Settled[];
}

export const emptyLanding = (): LandingState => ({ checking: null, recent: [] });

export function takeTurn(
	state: LandingState,
	holder: string,
	change: string,
	head: string,
	since: number,
	ttlMs: number,
	now = Date.now(),
): { state: LandingState; turn: { settled: Settled } | { lease: boolean } } {
	const settled = state.recent.findLast(
		(outcome) =>
			outcome.change === change &&
			outcome.head === head &&
			(outcome.how === "landed" || Date.parse(outcome.at) >= since),
	);
	if (settled) return { state, turn: { settled } };
	const { lease } = state;
	if (lease && lease.holder !== holder && lease.until > now) return { state, turn: { lease: false } };
	// An expired lease ended its holder's last batch, so that batch is no longer being checked.
	const checking = lease && lease.holder !== holder ? null : state.checking;
	return { state: { ...state, checking, lease: { holder, until: now + ttlMs } }, turn: { lease: true } };
}

/** Extends the lease without ever shortening it, so steps running in parallel each keep it as long as they need. */
export function renewLease(
	state: LandingState,
	holder: string,
	ttlMs: number,
	now = Date.now(),
): { state: LandingState; held: boolean } {
	if (state.lease?.holder !== holder) return { state, held: false };
	return { state: { ...state, lease: { holder, until: Math.max(state.lease.until, now + ttlMs) } }, held: true };
}

export const dropLease = (state: LandingState, holder: string): LandingState =>
	state.lease?.holder === holder ? { ...state, lease: undefined, checking: null } : state;

export const settleOutcomes = (state: LandingState, outcomes: Settled[]): LandingState => ({
	...state,
	recent: [...state.recent, ...outcomes].slice(-RECENT_KEPT),
});

/** A landing kept in memory, for tests and when there's no RepoCache. Only merges in this isolate share it. */
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
