import type { GateResult } from "./gate-plan";
import type { LaneChangeRequest } from "./lane-change-contract";

// Domain model. A task is a project repo open for changes: agents (outside or
// Blueprint's own) open changes as they arrive, each claiming the paths it will
// touch and working on its own Artifacts fork, and each change merges into the
// project once reviewed and checked. A change is stored as a slice.

export type Phase = "planning" | "awaiting-approval" | "building" | "landed";

/**
 * "opening": an open-mode change whose claim is held while its fork is made.
 * "abandoned": an open-mode change that was given up or whose claim expired; its lane is free again.
 */
export type SliceStatus = "opening" | "building" | "integrated" | "abandoned";

export interface SliceSpec {
	/** Lowercase slug, unique within the task. Used in repo names. */
	id: string;
	title: string;
	/** Path prefixes this slice may change, e.g. ["src/billing/"]. */
	owns: string[];
	/** What the slice must implement, written for the agent that builds it. */
	instructions: string;
	/**
	 * Contract test files this slice must make pass. Other slices' contract tests
	 * may fail on this slice alone; they pass once everything is integrated.
	 */
	tests?: string[];
}

export interface Slice extends SliceSpec {
	status: SliceStatus;
	/** When the change was opened, and who opened it: an Access identity's label (a person by a hash of their email), or "blueprint-builder" for a hosted change. */
	openedAt?: string;
	openedBy?: string;
	/** The name the agent gave itself (open_change's `agent`), for people; unverified, unlike `openedBy`. */
	agent?: string;
	/** When it merged or was abandoned. */
	endedAt?: string;
	/** Open mode: what the agent that opened this change set out to do. */
	intent?: string;
	/** Open mode: the project commit the change's fork started from (planned slices start at the task's baseCommit). */
	startCommit?: string;
	/** Open mode: when the change's claim expires unless it shows activity. */
	leaseUntil?: string;
	/**
	 * An external agent (for example through the MCP front door) works on this
	 * slice instead of a hosted builder. Messages for it, such as review
	 * findings and cross-lane requests, go to `inbox`, which it reads.
	 */
	external?: boolean;
	inbox?: { at: string; text: string }[];
	/** Artifacts repo name of this slice's fork. */
	repo?: string;
	/** Last commit seen on the fork's main. */
	head?: string;
	/** Paths changed relative to the task base, as of `head`. */
	touched: string[];
	/** Touched paths outside `owns`. Non-empty means the agent left its lane. */
	outOfLane: string[];
	/** Commit the builder asked to have reviewed. Reviews of other commits don't count. */
	reviewHead?: string;
	reviews: Review[];
	/** The builder's account of what it built, passed to reviewers. */
	buildSummary?: string;
	/**
	 * Where the slice's own changes start: the merge base of its head and the task
	 * base. Equals the base commit until the slice merges integrated work.
	 */
	mergeBase?: string;
	/** Times review or integration sent the slice back to its builder. */
	revisions?: number;
	/** The review head that was last sent back, so one verdict triggers one revision. */
	sentBackFor?: string;
	/** Why the slice needs a human, when the agents can't proceed on their own. */
	attention?: string;
	/** The findings that last sent the slice back; the next review checks them. */
	lastFeedback?: string;
	/** Human decisions to let a commit through without an approved quorum. */
	waivers?: { head: string; by: string; reason: string; at: string }[];
	/** The integration gate's run for the approved commit. */
	gate?: {
		/**
		 * "queued": waiting its turn in the task's gate queue. "waiting": failed
		 * while other slices weren't integrated yet; re-runs after the next integration.
		 */
		status: "queued" | "running" | "passed" | "failed" | "waiting";
		head: string;
		baseHead: string;
		at: string;
		/** Contract tests left out because their slices weren't integrated yet. */
		excluded: string[];
		/** Other slices merged in the same run, when slices depend on each other (a group gate). */
		group?: string[];
		result?: GateResult;
	};
	/** When the slice's builder parked to wait for its cross-lane requests, and which ones. */
	parkedAt?: string;
	parkedWaitingFor?: string[];
	/** Wake events not yet confirmed delivered, in order. An event leaves only after Builder.wake succeeds. */
	wakeOutbox?: { eventId: string; message: string }[];
	/** Wake events confirmed delivered, so a repeat is never sent twice. */
	wakeEventIds?: string[];
	/** The parkedAt whose 30-minute timeout has been flagged for a human, so it is flagged exactly once. */
	parkTimeoutFlagged?: string;
}

export const DEFAULT_POLICY: ReviewPolicy = {
	reviewers: ["security", "tests", "api"],
	required: 2,
	vetoes: ["security"],
};

/** Quorum: who reviews each slice before it may integrate into the base. */
export interface ReviewPolicy {
	/** Reviewer roles, e.g. ["security", "tests", "api"]. Each is one specialist agent. */
	reviewers: string[];
	/** Approvals needed to integrate. */
	required: number;
	/** Roles whose rejection blocks integration regardless of the count. */
	vetoes: string[];
}

export interface Review {
	reviewer: string;
	/** The commit reviewed. A review of an older head is stale and doesn't count. */
	head: string;
	verdict: "approve" | "reject";
	summary: string;
	/** Evidence the reviewer gathered: failing test output, an exploit, a benchmark. */
	evidence?: string;
	at: string;
}

export type QuorumStatus = "pending" | "approved" | "rejected" | "vetoed";

export type CheckStatus = "clean" | "disjoint" | "conflict";

/** Result of test-merging two in-progress heads (Merge-ahead). */
export interface MergeCheck {
	/** Slice ids, sorted. "base" stands for the task base's main. */
	pair: [string, string];
	heads: [string, string];
	status: CheckStatus;
	/** Conflicting paths when status is "conflict". */
	files: string[];
	checkedAt: string;
}

export interface Task {
	id: string;
	/** Project repo the task lands on. */
	repo: string;
	goal: string;
	phase: Phase;
	/** The repo changes fork from and integrate back into: the project repo itself. */
	baseRepo?: string;
	/** The project's head when the task was opened. */
	baseCommit?: string;
	/** Commands the integration gate runs on the combined code. Empty: integrate on approval. */
	verify: string[];
	review: ReviewPolicy;
	slices: Slice[];
	checks: MergeCheck[];
	/** How many builders and reviewers may run at once; more wait in `queue`. */
	limits: Limits;
	queue: QueueItem[];
	/** Agents running now: builder keys are slice ids; reviewer keys are slice:role:head. */
	active: { builders: string[]; reviewers: string[] };
	createdAt: string;
	/** The project's head when the task was created; task-wide decisions are noted on it until the base exists. */
	anchor?: string;
	/** Always "open": agents open changes and claim their lanes as they arrive, and changes merge straight into the project. (Planned mode lives on the plan-mode branch.) */
	mode?: "open";
	/** Open mode: minutes a change keeps its claim without activity. */
	leaseMinutes?: number;
	/** Builders' requests that another slice change something in its lane. */
	laneChangeRequests?: LaneChangeRequest[];
}

export interface Limits {
	builders: number;
	reviewers: number;
}

export const DEFAULT_LIMITS: Limits = { builders: 4, reviewers: 6 };

/** Agent work waiting for a free slot. */
export type QueueItem = { kind: "builder"; slice: string } | { kind: "reviewer"; slice: string; role: string; head: string };

/** Handed to the agent that builds or reviews a slice. Never persisted. */
export interface SliceCredentials {
	slice: string;
	repo: string;
	remote: string;
	token: string;
}

/** A reviewer's assignment: read-only access, pinned to one commit. */
export interface ReviewAssignment extends SliceCredentials {
	reviewer: string;
	head: string;
}
