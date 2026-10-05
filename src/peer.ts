import { remoteFor } from "./artifacts";
import { Coordinator } from "./coordinator";
import { statusOf } from "./errors";
import { type CasLog, campaign, Deposed, type ElectionRefs, type Leader } from "./election";
import { GitCasLog, cachedRemote, leaseRef } from "./election-git";
import { holdsClaim, nextLeaseCheck } from "./open-mode";
import type { LedgerEntry } from "./ledger";
import type { Task } from "./types";

// A peer of the elected coordinator: one per open change. Any peer can lead
// the task; while it does, it runs the same decision code as the fixed
// Coordinator, with the task kept in the shared log instead of its own storage.
// See docs/elected-coordinator.md.

/** Where a peer keeps which task it belongs to, so it can rejoin after its object restarts. */
const IDENTITY = "peer:identity";

/** Until when a peer is down, for failover tests (simulateCrash): kept in storage, so it outlasts a restart. */
const DOWN_UNTIL = "peer:down-until";

/** How long a leader's lease lasts unless renewed. */
export const PEER_LEASE_MS = 30_000;

/**
 * Start a task's log: the open task as its first state, with nobody leading
 * yet. `parent` continues an existing record on the same ref (a fixed
 * Coordinator's ledger, for a task moving to the elected coordinator).
 */
export async function openLog(log: CasLog<Task>, task: Task, entries: LedgerEntry[] = [], parent: string | null = null) {
	const tip = await log.append(parent, { term: 0, leader: "", leaseUntil: 0, kind: "genesis", entries, state: task, batch: crypto.randomUUID() });
	if (!tip) {
		const head = await log.read();
		if (head?.commit.state.id === task.id) return head.tip;
		throw new Error(`[409] the log for ${task.id} already exists`);
	}
	return tip;
}

export interface PeerOptions {
	/** The task's decision log and lease ref; Git unless a test gives others. */
	log: (taskId: string, repo: string) => CasLog<Task>;
	leases: (taskId: string, repo: string) => CasLog<null>;
	leaseMs: number;
	now: () => number;
}

export class Peer extends Coordinator {
	private options: PeerOptions = {
		log: (taskId, repo) => new GitCasLog<Task>(this.remote(repo), taskId),
		leases: (taskId, repo) => new GitCasLog<null>(this.remote(repo), taskId, leaseRef(taskId)),
		leaseMs: PEER_LEASE_MS,
		now: Date.now,
	};

	/** The task's refs, opened once: each keeps the tip it last saw. */
	private refs: ElectionRefs<Task> | null = null;

	/** One write token for both refs, reused while fresh. */
	private remoteCache: { repo: string; get: () => ReturnType<typeof remoteFor> } | null = null;

	private remote(repo: string) {
		if (this.remoteCache?.repo !== repo) this.remoteCache = { repo, get: cachedRemote(() => remoteFor(this.env.ARTIFACTS, repo, "write")) };
		return this.remoteCache.get;
	}

	private refsOf(taskId: string, repo: string) {
		this.refs ??= { log: this.options.log(taskId, repo), leases: this.options.leases(taskId, repo) };
		return this.refs;
	}

	/** While this peer leads: its hold on the log. */
	private leader: Leader<Task> | null = null;

	/** This peer's name, `<task>--<change>`: the change it belongs to. */
	private me: string | null = null;

	/** Who leads, as this peer last saw in the log, while that lease is live. */
	private known: { leader: string; term: number; leaseUntil: number } | null = null;

	/**
	 * The task as this leader's steps have left it, ahead of the log by the steps
	 * whose commit hasn't landed yet. Steps run one at a time, so each sees every
	 * step before it; none is answered until its commit is in the log.
	 */
	private working: Task | null = null;

	/** Decisions of the step that is running, and whether it saved the task. */
	private stepDecisions: LedgerEntry[] = [];
	private stepSaved = false;

	/** When the task's claim leases next need checking (set by the decision code). */
	private leaseCheckAt: number | null = null;

	/** Until when this peer is down (simulateCrash), once read from storage. */
	private downUntil: number | null = null;

	/**
	 * For failover tests: behave as if this object vanished for `forMs`. It
	 * stops leading without resigning, stops renewing its lease, and refuses
	 * every call (as an unreachable object would), so the others wait out its
	 * lease and one of them takes over. Afterwards it is a peer like any other.
	 */
	async simulateCrash(forMs: number) {
		this.downUntil = this.options.now() + forMs;
		await this.ctx.storage.put(DOWN_UNTIL, this.downUntil);
		await this.ctx.storage.deleteAlarm();
		this.leader = null;
		this.working = null;
		this.known = null;
		this.campaigning = null;
	}

	/** Refuse while down after a simulated crash. */
	private async refuseIfDown() {
		this.downUntil ??= (await this.ctx.storage.get<number>(DOWN_UNTIL)) ?? 0;
		if (this.options.now() < this.downUntil) throw new Error("[503] peer unavailable (simulated crash)");
	}

	/** For tests: another log, lease or clock. */
	configure(options: Partial<PeerOptions>) {
		this.options = { ...this.options, ...options };
	}

	/**
	 * Lead the task, or say who does. If nobody's lease is live, this peer
	 * campaigns; of several peers campaigning at once, one wins. `fresh` looks in
	 * the log even if this peer remembers a live lease (the leader it remembers
	 * said it no longer leads).
	 */
	async lead(taskId: string, repo: string, me: string, fresh = false): Promise<{ leader: string; term: number }> {
		await this.refuseIfDown();
		if (this.me !== me) await this.ctx.storage.put(IDENTITY, { taskId, repo, me });
		this.me = me;
		const now = this.options.now();
		const leader = this.leader;
		if (leader?.leading) {
			// Known without asking Git: this peer leads.
			if (leader.leaseExpires > now) return { leader: me, term: leader.term };
			// Its lease has passed by its own clock (a late alarm): renew it through
			// the leader it has, rather than campaign and replace it, which would
			// drop decisions still in flight.
			if ((await leader.heartbeat()) && leader.leading) return { leader: me, term: leader.term };
		}
		if (!fresh && this.known && this.known.leaseUntil > now) return { leader: this.known.leader, term: this.known.term };
		// One campaign at a time: concurrent calls share it, so a peer never holds two leaders for one term.
		this.campaigning ??= this.campaign(taskId, repo, me).finally(() => (this.campaigning = null));
		return this.campaigning;
	}

	/** A campaign in flight, shared by concurrent lead() calls. */
	private campaigning: Promise<{ leader: string; term: number }> | null = null;

	private async campaign(taskId: string, repo: string, me: string): Promise<{ leader: string; term: number }> {
		const outcome = await campaign(this.refsOf(taskId, repo), me, () => {
			throw new Error(`[404] no task ${taskId} on ${repo}`);
		}, { leaseMs: this.options.leaseMs, now: this.options.now });
		if (!outcome.leading) {
			this.known = { leader: outcome.leader, term: outcome.term, leaseUntil: outcome.leaseUntil };
			return { leader: outcome.leader, term: outcome.term };
		}
		this.known = null;
		this.leader = outcome.leader;
		await this.hint(taskId, me, outcome.term);
		this.working = structuredClone(outcome.leader.state);
		// The task's timers come with it: check claim leases when the earliest is due.
		this.leaseCheckAt = nextLeaseCheck(this.working);
		await this.armAlarm();
		return { leader: me, term: outcome.term };
	}


	/**
	 * The leader's alarm: renew the lease when two thirds of it has passed, and
	 * check claim leases when they are due. A peer that doesn't lead ignores it.
	 */
	override async alarm() {
		// Down after a simulated crash: renew nothing, so the lease runs out.
		if (await this.refuseIfDown().then(() => false, () => true)) return;
		if (!this.leader) await this.rejoin();
		const leader = this.leader;
		if (!leader?.leading) return;
		await leader.heartbeat();
		const now = this.options.now();
		if (this.leaseCheckAt !== null && now >= this.leaseCheckAt) {
			this.leaseCheckAt = null;
			await super.alarm();
		}
		await this.armAlarm();
	}

	protected override async setTimer(at: number): Promise<void> {
		this.leaseCheckAt = at;
		await this.armAlarm();
	}

	/** Set the alarm for whichever comes first: renewing the lease, or checking claims. */
	private async armAlarm() {
		const leader = this.leader;
		if (!leader?.leading) return;
		const renew = leader.leaseExpires - this.options.leaseMs / 3;
		await this.ctx.storage.setAlarm(Math.min(renew, this.leaseCheckAt ?? Number.POSITIVE_INFINITY));
	}

	/**
	 * The task as committed to the log, for reads. Never campaigns. The leader
	 * answers from memory; a peer that knows a live leader asks it (once, no
	 * further); otherwise the log is read, from this peer's own copy when the
	 * tip hasn't moved. A Durable Object stays put, so that copy stays warm.
	 */
	async peek(taskId: string, repo: string, me: string, forwarded = false): Promise<Task> {
		await this.refuseIfDown();
		this.me ??= me;
		if (this.leader?.leading) return structuredClone(this.leader.state);
		const now = this.options.now();
		const leader = forwarded ? null : await this.liveLeader(me);
		if (leader) {
			try {
				return await this.peerNamed(leader).peek(taskId, repo, leader, true);
			} catch (err) {
				console.error(`peek via ${leader} failed; reading the log`, statusOf(err).message);
			}
		}
		const refs = this.refsOf(taskId, repo);
		const [head, lease] = await Promise.all([refs.log.read(), refs.leases.read()]);
		if (!head) throw new Error(`[404] no task ${taskId} on ${repo}`);
		this.remember(lease?.commit, me, now);
		return head.commit.state;
	}

	/** Remember a live lease another peer holds, as read from the lease ref. */
	private remember(lease: { leader: string; term: number; leaseUntil: number } | undefined, me: string, now: number) {
		if (lease?.leader && lease.leader !== me && lease.leaseUntil > now) this.known = { leader: lease.leader, term: lease.term, leaseUntil: lease.leaseUntil };
	}

	/** Whether this peer leads, and until when: asked by a peer that remembers it as the leader. */
	async leaseStatus(): Promise<{ leading: boolean; term: number; leaseUntil: number }> {
		await this.refuseIfDown();
		const leader = this.leader;
		return leader?.leading ? { leading: true, term: leader.term, leaseUntil: leader.leaseExpires } : { leading: false, term: 0, leaseUntil: 0 };
	}

	private peerNamed(name: string) {
		return this.env.PEER.getByName(name) as unknown as Peer;
	}

	/**
	 * The leader this peer knows of with a live lease. Past the lease it saw, it
	 * asks that leader whether it renewed (a call between objects) before
	 * anyone has to read the log.
	 */
	private async liveLeader(me: string): Promise<string | null> {
		const known = this.known;
		if (!known || known.leader === me) return null;
		const now = this.options.now();
		if (known.leaseUntil > now) return known.leader;
		try {
			const status = await this.peerNamed(known.leader).leaseStatus();
			if (status.leading && status.leaseUntil > now) {
				this.known = { leader: known.leader, term: status.term, leaseUntil: status.leaseUntil };
				return known.leader;
			}
		} catch (err) {
			console.error(`asking ${known.leader} for its lease failed`, statusOf(err).message);
		}
		this.known = null;
		return null;
	}

	/** Tell the task index who leads, so the Worker can reach the leader in one hop. Advice only: a failure is logged, not thrown. */
	private async hint(taskId: string, leader: string | null, term: number) {
		try {
			await this.env.TASK_INDEX.getByName("all").hintLeader(taskId, leader, term);
		} catch (err) {
			console.error(`noting ${leader ?? "no leader"} for ${taskId} in the task index failed`, statusOf(err).message);
		}
	}

	/** Refuse to decide without leading: the caller should ask the peer that does. */
	private leading() {
		if (!this.leader?.leading || !this.working) throw this.leader ? new Deposed(null, this.leader.term) : new Error("[409] no longer leading: this peer does not lead the task");
		return this.working;
	}

	/**
	 * After its object restarted (evicted while idle, say), a peer has nothing in
	 * memory, yet the lease ref may still name it leader. It campaigns again from
	 * the identity it saved: with its lease still live that resumes its term,
	 * with the state from the log. Returns whether it leads.
	 */
	private async rejoin(): Promise<boolean> {
		const identity = await this.ctx.storage.get<{ taskId: string; repo: string; me: string }>(IDENTITY);
		if (!identity) return false;
		const { leader } = await this.lead(identity.taskId, identity.repo, identity.me);
		return leader === identity.me;
	}

	protected override async readTask(): Promise<Task | undefined> {
		await this.refuseIfDown();
		if (!this.leader) await this.rejoin();
		// A copy, like storage gives: a step that fails changes nothing it didn't save.
		return structuredClone(this.leading());
	}

	protected override async writeTask(task: Task): Promise<void> {
		this.leading();
		this.working = structuredClone(task);
		this.stepSaved = true;
	}

	protected override recordDecision(entry: LedgerEntry) {
		this.stepDecisions.push(entry);
	}

	/**
	 * Commit the step to the log: what it saved, and its decisions if it
	 * succeeded. The answer waits for the commit; the next step doesn't.
	 */
	protected override async finishStep(ok: boolean): Promise<{ durable: Promise<void> }> {
		const entries = ok ? this.stepDecisions : [];
		const saved = this.stepSaved;
		this.stepDecisions = [];
		this.stepSaved = false;
		const leader = this.leader;
		// A step that saved nothing and decided nothing (a refusal, a read) has nothing to commit.
		if (!leader?.leading || !this.working || (!saved && !entries.length)) return { durable: Promise.resolve() };
		const state = structuredClone(this.working);
		const durable = leader.decide(() => ({ state, entries, result: undefined })).then(() => this.resignIfDone(leader, state));
		return { durable };
	}

	/**
	 * Once no change on the task is active, there is nothing left to coordinate:
	 * hand the lead over, so the next change to arrive takes it at once. While
	 * any change is active the leader stays in charge, even after its own change
	 * has ended, so reads come from its memory and new changes skip an election.
	 */
	private async resignIfDone(leader: Leader<Task>, state: Task) {
		if (state.slices.some(holdsClaim) || !leader.leading) return;
		await leader.resign();
		await this.hint(state.id, null, leader.term);
		this.working = null;
	}
}
