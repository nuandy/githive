import type { Remote } from "../git";
import type { ReadHistory } from "./batch-reads";
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

/**
 * Runs the project's checks on `base` with `changes` merged in order, which is what main becomes once they land.
 * They run in the Gate container named `gate`, or else the last change's.
 */
export type CheckRunner = (input: {
	base: string;
	branch: string;
	changes: BatchChange[];
	commands: string[];
	gate?: string;
}) => Promise<{ passed: boolean; results: CheckResult[] }>;

/** A change in a batch before its head is read. */
export type BatchSource = Omit<BatchChange, "head">;

/** A change's head and the files it changed since it left main, or why it couldn't be read. */
export type Inspected = { change: string; head: string; files: string[] } | { change: string; error: string };

/**
 * A batch's git work, done with real git in the repo's own Gate. That container never runs a change's code, so what it
 * reads and pushes can be trusted (see gate.ts). Landed in a Worker's memory instead, big batches ran out of it.
 */
export interface BatchGit {
	/** Each change's head now and the files it changed since it left `base`. */
	inspect(input: { base: string; branch: string; changes: BatchSource[] }): Promise<Inspected[]>;
	/**
	 * Lands `merges` on `base` in order and in one push, each as its own merge commit with its claim's trailers and
	 * GitHive's stamp. Returns their commits, or "moved" if the branch is no longer at `base`.
	 */
	land(input: {
		base: string;
		branch: string;
		merges: (BatchChange & { claimed: Omit<MergeClaim, "base"> })[];
		by?: string;
		stamper?: Stamper;
	}): Promise<{ commits: string[] } | "moved">;
	/**
	 * Merges `changes` onto `base` as they would land and pushes the result to `ref` on `to`, a connected GitHub repo,
	 * for its Actions to check. Returns the tip, or why it failed.
	 */
	checksBranch(input: {
		base: string;
		branch: string;
		changes: BatchChange[];
		to: Remote;
		ref: string;
	}): Promise<{ tip: string } | { failed: string }>;
	/** Fast-forwards `branch` on `to` (GitHub's copy) to `head`, and throws if that's refused. */
	pushBranch(input: { branch: string; head: string; to: Remote }): Promise<void>;
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
	/** Timings that default to POLL_MS, ANSWER_WITHIN_MS, HEARTBEAT_MS and LEASE_TTL_MS. Tests shorten them. */
	pollMs?: number;
	answerWithinMs?: number;
	heartbeatMs?: number;
	leaseTtlMs?: number;
}

export type MergeOutcome =
	| { ok: true; commit: string; /** Why no checks ran, when they're configured. */ checks?: string }
	| {
			ok: false;
			reasons: string[];
			conflicts?: string[];
			/** The changes that last landed on each conflicted file. */
			causes?: ReturnType<typeof lastLandedOn>;
			checks?: CheckResult[];
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
