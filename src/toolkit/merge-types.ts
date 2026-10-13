import type { Clef } from "../clef";
import type { GitHubImportResult } from "../gate-github";
import type { Hunk, Remote } from "../git";
import type { ReadHistory, TouchedBy } from "./batch-reads";
import type { ClaimRecord } from "./claims";
import type { ClaimStore, ClaimsView } from "./claim-store";
import type { Landing, lastLandedOn } from "./landing";
import type { MergeClaim } from "./merge-commit";
import type { Stamper } from "./stamp";
import type { VoteStore, VotesView } from "./vote-store";
import type { ReviewPolicy } from "./votes";

export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

/** A change in what the checks run on. */
export interface BatchChange {
	change: string;
	head: string;
	ref: string;
	/** The change's fork; absent for a branch in the project repo. */
	source?: Remote;
	agent: string;
}

/** The files a change doesn't merge on, and who changed them on the branch since it left, where that was read. */
export interface Conflict {
	files: string[];
	touchedBy?: TouchedBy[];
}

/**
 * Runs the project's checks on `base` with `changes` merged in order, which is what main becomes once they land.
 * They run in the Gate container named `gate`, or else the last change's. A batch that doesn't merge says on what, in
 * `conflict`, besides its failed step in `results`.
 */
export type CheckRunner = (input: {
	base: string;
	branch: string;
	changes: BatchChange[];
	commands: string[];
	gate?: string;
}) => Promise<{ passed: boolean; results: CheckResult[]; conflict?: Conflict }>;

/** A change in a batch before its head is read, and the head it was last seen at, if any. */
export type BatchSource = Omit<BatchChange, "head"> & { seen?: string };

/** A change's head and the files it changed since it left main, or why it couldn't be read. */
export type Inspected = { change: string; head: string; files: string[] } | { change: string; error: string };

/**
 * A batch's git work: landed with trees in the Worker (see tree-landing.ts), or with real git in the repo's own Gate.
 * That container never runs a change's code, so what it reads and pushes can be trusted (see gate.ts).
 */
export interface BatchGit {
	/** Each change's head now and the files it changed since it left `base`. */
	inspect(input: { base: string; branch: string; changes: BatchSource[] }): Promise<Inspected[]>;
	/**
	 * Lands `merges` on `base` in order and in one push, each as its own merge commit with its claim's trailers and
	 * GitHive's stamp. Returns their commits, "moved" if the branch is no longer at `base`, or why nothing landed:
	 * with the change that didn't merge onto the batch and its files, when that's what failed.
	 */
	land(input: {
		base: string;
		branch: string;
		merges: (BatchChange & { claimed: Omit<MergeClaim, "base"> })[];
		by?: string;
		stamper?: Stamper;
	}): Promise<{ commits: string[] } | "moved" | Unlanded>;
	/**
	 * Merges `changes` onto `base` as they would land and pushes the result to `ref` on `to`, a connected GitHub repo,
	 * for its Actions to check. Returns the tip, or why it failed: with the change that didn't merge, and its files.
	 */
	checksBranch(input: {
		base: string;
		branch: string;
		changes: BatchChange[];
		to: Remote;
		ref: string;
	}): Promise<{ tip: string } | Unlanded>;
	/**
	 * Fast-forwards `as` (by default `branch`) on `to`, GitHub's copy, to `head` from the project's `branch`, and throws
	 * if that's refused.
	 */
	pushBranch(input: { branch: string; head: string; to: Remote; as?: string }): Promise<void>;
	/**
	 * Fetches `githubBranch` from `from` (GitHub) and, unless the project's `branch` at `base` has it, writes it to the
	 * project's `as`, joined to the work of GitHive's it already took (see gate-github.ts).
	 */
	importBranch?(input: {
		base: string;
		branch: string;
		from: Remote;
		githubBranch: string;
		as: string;
	}): Promise<GitHubImportResult>;
}

/**
 * Why a batch didn't land or merge, and the change that didn't merge onto it with its files, when that's why: git
 * names the change whose merge failed, and lists its files where it can (none when it didn't say).
 */
export interface Unlanded {
	failed: string;
	conflict?: { change: string; files: string[] };
}

/** Another change that may land with this one: its claim, its head as last seen, and where its branch lives. */
export interface Candidate {
	claim: ClaimRecord;
	/** Null or absent when nothing had been pushed. */
	head?: string | null;
	source: () => Promise<Remote>;
}

export interface MergeInput {
	remote: Remote;
	branch: string;
	/** The change's fork; by default the project repo. */
	source?: Remote;
	/** The repo's claims: checked before merging, cited on the merge, released after. */
	store: ClaimStore;
	/** The repo's votes: counted on the change's head, and cited on the merge. */
	votes: VoteStore;
	policy: ReviewPolicy;
	/** The project's checks; none means the merge isn't tested. */
	verify?: string[];
	/** What the checks skip (see check-scope.ts); the defaults when absent. */
	skipChecks?: string[];
	runChecks?: CheckRunner;
	/** Stamps the merges and the releases with the caller's verified identity. */
	stamper?: Stamper;
	/** The registry's stamp key. When set, only stamped votes count. */
	stampKey?: string;
	/**
	 * Whether a change lands without votes at `head`: GitHub's changes, brought in by githive-github, while the repo
	 * trusts them (see github-settings.ts). Its checks still run.
	 */
	trusted?: (claim: ClaimRecord, head: string) => Promise<boolean>;
	change: string;
	agent: string;
	/** Maps a file to its name in the claims records, for a branch other than the project's (see branch-scope.ts). */
	scope?: (file: string) => string;
	/**
	 * The branch's head, cached for all the merges watching it; listed each time when absent. A slightly stale head is
	 * safe because a batch pushes by compare-and-swap and tries again if the branch moved.
	 */
	branchHead?: () => Promise<string | null>;
	/** The other changes into this branch that may land with this one. */
	others?: () => Promise<Candidate[]>;
	/** The branch's lease and recent outcomes. Without it they're kept for this merge only. */
	landing?: Landing;
	batchGit: BatchGit;
	/** Reads history through Artifacts' API, so a change can often be checked without a fetch (see changeAgainst). */
	history?: ReadHistory;
	/** Each change's earlier attempts to land, for its merge commit's story (see ToolContext.attemptsOf). */
	attemptsOf?: (changes: string[]) => Promise<Record<string, string[]>>;
	/** Starts the container for a batch's first check while the batch is read, so the check finds it running. */
	prepareChecks?: (gate: string) => Promise<void>;
	/** Starts the repo's Gate while the batch is read, so landing doesn't wait for its container to start. */
	prepareLanding?: () => Promise<void>;
	/** Fetches this merge's change ahead of its landing, while it waits for its turn (see tree-landing.ts). */
	prefetch?: (change: BatchChange) => Promise<void>;
	/** Caps what batchSize gives. Tests set a small cap so that batches follow each other. */
	maxBatch?: number;
	/** Runs after a batch lands and its claims are released, such as pushing main to GitHub. Failures are logged. */
	afterLanding?: (commit: string) => Promise<void>;
	/**
	 * Says a landed batch's claims are released. The landing rang before they were, and agents that looked then saw
	 * the pieces still claimed. Failures are ignored.
	 */
	releasedLanded?: () => Promise<void>;
	/** Notes a line on a change's attempt to land (a conflict, failed checks) for its merge commit. Never fails. */
	noteAttempt?: (change: string, line: string) => Promise<void>;
	/** Clef, asked about a batch's failed checks for hints (see failure-hints.ts). It never changes what lands. */
	clef?: Clef;
	/** Timings that default to POLL_MS, ANSWER_WITHIN_MS, HEARTBEAT_MS and LEASE_TTL_MS. Tests shorten them. */
	pollMs?: number;
	answerWithinMs?: number;
	heartbeatMs?: number;
	leaseTtlMs?: number;
}

/**
 * What a refused merge's reasons are about, so what follows can be worked out without reading their words:
 * - conflict: it doesn't merge onto the branch (`into`); conflicts, touchedBy, hunks and fix say more where known.
 * - checks: its checks failed, in this batch or on this head before; `checks` has the failed step where known.
 * - unclaimed: its change holds no claim.
 * - outside: it changes files outside its claim (`outsideClaim`).
 * - inside: it changes files inside others' claims (`insideOthers`).
 * - changes-asked: it's vetoed, or a reviewer asked for changes.
 * - approvals: approvals are still missing.
 * - after: what it depends on hasn't merged yet.
 * - moved: the branch kept moving while it merged.
 * - unread: its branch couldn't be read.
 * - pending: not refused; it's ready and waiting to land.
 * - setup: the repo's setup keeps it from landing, such as checks on Actions with no GitHub repo reached.
 */
export type Why =
	| "conflict"
	| "checks"
	| "unclaimed"
	| "outside"
	| "inside"
	| "changes-asked"
	| "approvals"
	| "after"
	| "moved"
	| "unread"
	| "pending"
	| "setup";

export type MergeOutcome =
	| { ok: true; commit: string; /** Why no checks ran, when they're configured. */ checks?: string }
	| {
			ok: false;
			/** For people. What follows is worked out from `why` and the fields beside it, never from these words. */
			reasons: string[];
			/** Each kind of reason the refusal has, once, in the order of its reasons. */
			why: Why[];
			/** The branch it conflicts with, and the head that conflicts. */
			into?: string;
			head?: string;
			conflicts?: string[];
			/** The changes that last landed on each conflicted file. */
			causes?: ReturnType<typeof lastLandedOn>;
			/** Every commit on the branch since the change left it that changed a conflicted file (see touchedSince). */
			touchedBy?: TouchedBy[];
			/** Each conflicted file with its conflict markers, cut to a few KB (see Workspace.tryMerge). */
			hunks?: Hunk[];
			/** The commands that resolve the conflict in the clone credentials gives, then what to call. */
			fix?: string[];
			checks?: CheckResult[];
			/** How likely Clef found it that the environment, not the code, failed its checks, when it's likely. */
			environment?: number;
			/** The files it changes outside its own claim, and inside others' claims. */
			outsideClaim?: string[];
			insideOthers?: string[];
			/** Not refused but still waiting; merging again keeps waiting. */ pending?: true;
	  };

export type Refused = Extract<MergeOutcome, { ok: false }>;

// A change ready to land: it passed its claim and vote checks and merges cleanly onto main.
export interface Ready {
	change: string;
	agent: string;
	head: string;
	ref: string;
	source?: Remote;
	files: string[];
	// The files as the claims records name them.
	scoped: string[];
	claims: ClaimsView;
	own: ClaimRecord;
	votes: VotesView;
	// True when it only touches files the checks skip.
	skipped: boolean;
}
