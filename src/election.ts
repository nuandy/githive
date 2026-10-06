import type { LedgerEntry } from "./ledger";

// The elected coordinator's protocol. Peers share two append-only refs and
// nothing else: the decision log and the lease ref. Every append is
// compare-and-swap: it lands only on the tip it was built on. One peer at a
// time leads, under a lease kept on the lease ref (elections, heartbeats,
// resignations). Having won the lease, it writes a term marker to the decision
// log, then appends decisions there, each commit fenced by its term. Safety
// rests on compare-and-swap of the decision log alone; the lease and clocks
// only decide when another peer may try to take over. The decision log grows
// only with decisions and elections. See docs/elected-coordinator.md.

/** On the decision log: genesis, term (a new leader's marker), decisions. On the lease ref: election, heartbeat, resignation. */
export type CommitKind = "genesis" | "term" | "decisions" | "election" | "heartbeat" | "resignation";

/** One commit on either ref: who leads (until when, on the lease ref), what was decided, and the state after it. */
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
	/** Why the last append didn't land: another writer moved the tip, or the server stayed busy. */
	lastRefusal?: "moved" | "busy" | null;
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

/** The two refs of a task: decisions, and who leads. Lease commits carry no state. */
export interface ElectionRefs<S> {
	log: CasLog<S>;
	leases: CasLog<null>;
}

export type CampaignResult<S> =
	| { leading: true; term: number; leader: Leader<S> }
	| { leading: false; term: number; leader: string; leaseUntil: number };

const CAMPAIGN_ATTEMPTS = 5;

const batchId = () => crypto.randomUUID();

/**
 * Lead if nobody else does. Leaves a leader with a live lease in charge; takes
 * over (term + 1) when there is no lease yet, it ran out, or the leader
 * resigned. Of several peers campaigning at once, exactly one wins the lease;
 * the winner then writes its term marker to the decision log, and stands down
 * if a newer term got there first (it stalled, and another peer took over).
 */
export async function campaign<S>(refs: ElectionRefs<S>, me: string, initial: () => S, options: ElectionOptions): Promise<CampaignResult<S>> {
	const now = options.now ?? Date.now;
	for (let attempt = 1; ; attempt++) {
		const leaseHead = await refs.leases.read();
		const lease = leaseHead?.commit;
		if (lease && lease.leaseUntil > now()) {
			if (lease.leader === me) {
				const log = await refs.log.read();
				if (log && log.commit.term === lease.term && log.commit.leader === me)
					return { leading: true, term: lease.term, leader: new Leader(refs, me, lease.term, log.tip, log.commit.state, leaseHead.tip, lease.leaseUntil, options) };
				// Our lease, but not our term in the log: finish taking over.
				return markTerm(refs, me, lease.term, leaseHead.tip, lease.leaseUntil, initial, options);
			}
			return { leading: false, term: lease.term, leader: lease.leader, leaseUntil: lease.leaseUntil };
		}
		const election: LogCommit<null> = { term: (lease?.term ?? 0) + 1, leader: me, leaseUntil: now() + options.leaseMs, kind: "election", entries: [], state: null, batch: batchId() };
		const leaseTip = await appendOnce(refs.leases, leaseHead?.tip ?? null, election);
		if (leaseTip) return markTerm(refs, me, election.term, leaseTip, election.leaseUntil, initial, options);
		// Someone else moved first: look again.
		if (attempt === CAMPAIGN_ATTEMPTS) throw new Error("[503] the lease kept moving during the election; try again");
	}
}

/**
 * Having won the lease for `term`, write the term marker to the decision log.
 * The marker fences every earlier leader: their next append is built on a tip
 * that has moved. If the log already holds a newer term, either another peer
 * took over while this one stalled (the lease ref has moved too: stand down),
 * or the lease ref is behind the log (lost or reset): then raise this lease
 * above the log's term, on the lease tip this peer holds, and go on.
 */
async function markTerm<S>(refs: ElectionRefs<S>, me: string, term: number, leaseTip: string, leaseUntil: number, initial: () => S, options: ElectionOptions): Promise<CampaignResult<S>> {
	for (let attempt = 1; ; attempt++) {
		const head = await refs.log.read();
		const last = head?.commit;
		if (last && last.term > term) {
			const raised: LogCommit<null> = { term: last.term + 1, leader: me, leaseUntil, kind: "election", entries: [], state: null, batch: batchId() };
			const tip = await appendOnce(refs.leases, leaseTip, raised);
			if (!tip) return { leading: false, term: last.term, leader: last.leader, leaseUntil: 0 };
			term = raised.term;
			leaseTip = tip;
			continue;
		}
		const marker: LogCommit<S> = { term, leader: me, leaseUntil: 0, kind: "term", entries: [], state: last ? last.state : initial(), batch: batchId() };
		const tip = await appendOnce(refs.log, head?.tip ?? null, marker);
		if (tip) return { leading: true, term, leader: new Leader(refs, me, term, tip, marker.state, leaseTip, leaseUntil, options) };
		// The log moved: an earlier leader's last decision, or a newer term. Look again.
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
	private readonly log: CasLog<S>;
	private readonly leases: CasLog<null>;
	/** A lease renewal in flight, so two don't race each other. */
	private renewing: Promise<boolean> | null = null;

	constructor(
		refs: ElectionRefs<S>,
		readonly me: string,
		readonly term: number,
		/** The decision log's tip, as this leader last wrote or adopted it. */
		private tip: string,
		private current: S,
		/** The lease ref's tip, as this leader last wrote it. */
		private leaseTip: string,
		private leaseUntil: number,
		private readonly options: ElectionOptions,
	) {
		this.now = options.now ?? Date.now;
		this.log = refs.log;
		this.leases = refs.leases;
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

	/**
	 * Renew the lease if two thirds of it has passed, on the lease ref only.
	 * Returns whether it renewed. Finding another peer's lease there means this
	 * peer no longer leads.
	 */
	async heartbeat(): Promise<boolean> {
		if (this.deposed || this.leaseUntil - this.now() > this.options.leaseMs / 3) return false;
		this.renewing ??= this.writeLease("heartbeat", this.now() + this.options.leaseMs).finally(() => (this.renewing = null));
		return this.renewing;
	}

	/** Give up the lead, so the next peer takes over at once instead of waiting out the lease. */
	async resign(): Promise<void> {
		if (this.deposed) return;
		await this.writeLease("resignation", this.now());
		this.deposed ??= new Deposed(null, this.term);
	}

	/** Append to the lease ref, fenced like decisions: someone else's lease there deposes this leader. */
	private async writeLease(kind: "heartbeat" | "resignation", leaseUntil: number, retried = false): Promise<boolean> {
		const commit: LogCommit<null> = { term: this.term, leader: this.me, leaseUntil, kind, entries: [], state: null, batch: batchId() };
		const tip = await appendOnce(this.leases, this.leaseTip, commit);
		if (tip) {
			this.leaseTip = tip;
			this.leaseUntil = leaseUntil;
			return true;
		}
		const head = await this.leases.read();
		if (!retried && head && head.commit.term === this.term && head.commit.leader === this.me) {
			// A renewal of ours this leader didn't know about: build on it.
			this.leaseTip = head.tip;
			return this.writeLease(kind, leaseUntil, true);
		}
		this.deposed = new Deposed(head?.commit.leader ?? null, head?.commit.term ?? this.term);
		return false;
	}

	private enqueue(decision: Decision<S, unknown>) {
		if (this.deposed) return Promise.reject(this.deposed);
		return new Promise<unknown>((resolve, reject) => {
			this.queue.push({ decision, resolve, reject });
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
			const commit: LogCommit<S> = { term: this.term, leader: this.me, leaseUntil: 0, kind: "decisions", entries, state, batch: batchId() };
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
			return "landed";
		}
		const head = await this.log.read();
		if (!head || head.commit.term !== this.term || head.commit.leader !== this.me) {
			this.deposed = new Deposed(head?.commit.leader ?? null, head?.commit.term ?? this.term);
			return "deposed";
		}
		this.tip = head.tip;
		this.current = head.commit.state;
		return "moved";
	}
}
