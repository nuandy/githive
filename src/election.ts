import type { LedgerEntry } from "./ledger";

// The elected coordinator's protocol. Peers share one append-only log (in
// Git: a task's notes ref) and nothing else. Every append is compare-and-swap:
// it lands only on the tip it was built on. One peer at a time leads, under a
// lease recorded in the log; it alone appends decisions, each commit fenced by
// its term. Safety rests on compare-and-swap alone; leases and clocks only
// decide when another peer may try to take over. See docs/elected-coordinator.md.

export type CommitKind = "genesis" | "election" | "decisions" | "heartbeat" | "resignation";

/** One commit in the log: who leads, until when, what was decided, and the state after it. */
export interface LogCommit<S> {
	term: number;
	leader: string;
	/** Milliseconds since the epoch; a resignation's lease ends when it is written. */
	leaseUntil: number;
	kind: CommitKind;
	entries: LedgerEntry[];
	state: S;
	/** Unique per append, so a writer can tell whether a push whose answer was lost landed. */
	batch: string;
}

/** The log as compare-and-swap storage. */
export interface CasLog<S> {
	/** The tip and its commit, or null when nothing has been written. */
	read(): Promise<{ tip: string; commit: LogCommit<S> } | null>;
	/** Append on top of `parent` (null for an empty log): the new tip, or null when the tip had moved. */
	append(parent: string | null, commit: LogCommit<S>): Promise<string | null>;
}

export interface ElectionOptions {
	leaseMs: number;
	now?: () => number;
}

/** Thrown at a peer that tried to decide without leading: who leads now, in which term. */
export class Deposed extends Error {
	constructor(
		readonly leader: string | null,
		readonly term: number,
	) {
		super(leader ? `[409] no longer leading: ${leader} leads term ${term}` : `[409] no longer leading: resigned in term ${term}`);
		this.name = "Deposed";
	}
}

/** A decision: given the state, the next state, what to record, and what to answer. Throwing refuses it. */
export type Decision<S, R> = (state: S) => { state: S; entries: LedgerEntry[]; result: R };

export type CampaignResult<S> =
	| { leading: true; term: number; leader: Leader<S> }
	| { leading: false; term: number; leader: string; leaseUntil: number };

const CAMPAIGN_ATTEMPTS = 5;

const batchId = () => crypto.randomUUID();

/**
 * Lead if nobody else does. Leaves a leader with a live lease in charge; takes
 * over (term + 1) when there is no log yet, the lease ran out, or the leader
 * resigned. Of several peers campaigning at once, exactly one wins.
 */
export async function campaign<S>(log: CasLog<S>, me: string, initial: () => S, options: ElectionOptions): Promise<CampaignResult<S>> {
	const now = options.now ?? Date.now;
	for (let attempt = 1; ; attempt++) {
		const head = await log.read();
		const last = head?.commit;
		if (last && last.leaseUntil > now()) {
			if (last.leader === me) return { leading: true, term: last.term, leader: new Leader(log, me, last.term, head.tip, last.state, last.leaseUntil, options) };
			return { leading: false, term: last.term, leader: last.leader, leaseUntil: last.leaseUntil };
		}
		const election: LogCommit<S> = {
			term: (last?.term ?? 0) + 1,
			leader: me,
			leaseUntil: now() + options.leaseMs,
			kind: "election",
			entries: [],
			state: last ? last.state : initial(),
			batch: batchId(),
		};
		const tip = await appendOnce(log, head?.tip ?? null, election);
		if (tip) return { leading: true, term: election.term, leader: new Leader(log, me, election.term, tip, election.state, election.leaseUntil, options) };
		// Someone else moved first: look again.
		if (attempt === CAMPAIGN_ATTEMPTS) throw new Error("[503] the log kept moving during the election; try again");
	}
}

/** Append, finding out whether a push whose answer was lost landed. */
async function appendOnce<S>(log: CasLog<S>, parent: string | null, commit: LogCommit<S>) {
	try {
		return await log.append(parent, commit);
	} catch (err) {
		const head = await log.read();
		if (head?.commit.batch === commit.batch) return head.tip;
		throw err;
	}
}

interface Pending<S> {
	decision: Decision<S, unknown>;
	resolve: (result: unknown) => void;
	reject: (err: unknown) => void;
	/** Not a decision: renew the lease, or give it up. */
	control?: "heartbeat" | "resign";
}

/**
 * A peer while it leads. Decisions are answered only once they are in the
 * log. Decisions that arrive while a push is in flight go out together in the
 * next commit, applied in order.
 */
export class Leader<S> {
	private queue: Pending<S>[] = [];
	/** Whether a flush is running; it drains the queue before it stops. */
	private flushing = false;
	private deposed: Deposed | null = null;
	private readonly now: () => number;

	constructor(
		private readonly log: CasLog<S>,
		readonly me: string,
		readonly term: number,
		private tip: string,
		private current: S,
		private leaseUntil: number,
		private readonly options: ElectionOptions,
	) {
		this.now = options.now ?? Date.now;
	}

	/** The state as of the last commit this leader landed. */
	get state(): S {
		return this.current;
	}

	/** When this leader's lease ends, unless renewed. */
	get leaseExpires() {
		return this.leaseUntil;
	}

	/** Whether this peer still believes it leads (a fenced append is what proves it). */
	get leading() {
		return !this.deposed;
	}

	/** Decide, and answer once the decision is in the log. Rejects with Deposed if another peer leads. */
	decide<R>(decision: Decision<S, R>): Promise<R> {
		return this.enqueue(decision as Decision<S, unknown>) as Promise<R>;
	}

	/** Renew the lease if two thirds of it has passed. Returns whether it renewed. */
	async heartbeat(): Promise<boolean> {
		if (this.deposed || this.leaseUntil - this.now() > this.options.leaseMs / 3) return false;
		await this.enqueue((state) => ({ state, entries: [], result: true }), "heartbeat");
		return true;
	}

	/** Give up the lead, so the next peer takes over at once instead of waiting out the lease. */
	async resign(): Promise<void> {
		if (this.deposed) return;
		await this.enqueue((state) => ({ state, entries: [], result: undefined }), "resign");
		this.deposed = new Deposed(null, this.term);
	}

	private enqueue(decision: Decision<S, unknown>, control?: Pending<S>["control"]) {
		if (this.deposed) return Promise.reject(this.deposed);
		return new Promise<unknown>((resolve, reject) => {
			this.queue.push({ decision, resolve, reject, control });
			// Started synchronously: the first decision goes out at once, and later
			// ones queue behind its push.
			if (!this.flushing) {
				this.flushing = true;
				void this.flush();
			}
		});
	}

	private async flush() {
		// The flag is cleared in the same synchronous step that finds the queue
		// empty (no await in between), so a decision queued after that always
		// starts a new flush.
		try {
			while (this.queue.length) await this.commitBatch(this.queue.splice(0));
		} finally {
			this.flushing = false;
		}
	}

	/** Commit one batch: apply its decisions in order, append once, answer each. */
	private async commitBatch(batch: Pending<S>[]) {
		for (;;) {
			if (this.deposed) {
				for (const item of batch) item.reject(this.deposed);
				return;
			}
			// Apply in order; a decision that throws is refused on its own.
			let state = this.current;
			const entries: LedgerEntry[] = [];
			const applied: { item: Pending<S>; result: unknown }[] = [];
			for (const item of batch) {
				try {
					const outcome = item.decision(state);
					state = outcome.state;
					entries.push(...outcome.entries);
					applied.push({ item, result: outcome.result });
				} catch (err) {
					item.reject(err);
				}
			}
			if (!applied.length) return;
			const resigning = applied.some(({ item }) => item.control === "resign");
			const commit: LogCommit<S> = {
				term: this.term,
				leader: this.me,
				leaseUntil: resigning ? this.now() : this.now() + this.options.leaseMs,
				kind: resigning ? "resignation" : entries.length ? "decisions" : "heartbeat",
				entries,
				state,
				batch: batchId(),
			};
			let outcome: "landed" | "deposed" | "moved";
			try {
				outcome = await this.append(commit);
			} catch (err) {
				// The push failed and didn't land: refuse this batch; the next one tries again.
				for (const { item } of applied) item.reject(err);
				return;
			}
			if (outcome === "landed") {
				this.current = state;
				for (const { item, result } of applied) item.resolve(result);
				return;
			}
			if (outcome === "deposed") {
				for (const { item } of applied) item.reject(this.deposed);
				return;
			}
			// "moved": the tip is a commit of ours this leader didn't know about. It
			// adopted that commit, so apply the batch again on top of its state.
			batch = applied.map(({ item }) => item);
		}
	}

	/** Append on top of this leader's tip, fenced by its term. */
	private async append(commit: LogCommit<S>): Promise<"landed" | "deposed" | "moved"> {
		const tip = await appendOnce(this.log, this.tip, commit);
		if (tip) {
			this.tip = tip;
			this.leaseUntil = commit.leaseUntil;
			return "landed";
		}
		const head = await this.log.read();
		if (!head || head.commit.term !== this.term || head.commit.leader !== this.me) {
			this.deposed = new Deposed(head?.commit.leader ?? null, head?.commit.term ?? this.term);
			return "deposed";
		}
		this.tip = head.tip;
		this.current = head.commit.state;
		this.leaseUntil = head.commit.leaseUntil;
		return "moved";
	}
}
