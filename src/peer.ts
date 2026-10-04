import { remoteFor } from "./artifacts";
import { Coordinator } from "./coordinator";
import { type CasLog, campaign, Deposed, type Leader } from "./election";
import { GitCasLog } from "./election-git";
import { holdsClaim, nextLeaseCheck } from "./open-mode";
import type { LedgerEntry } from "./ledger";
import type { Task } from "./types";

// A peer of the elected coordinator: one per open change. Any peer can lead
// the task; while it does, it runs the same decision code as the fixed
// Coordinator, with the task kept in the shared log instead of its own storage.
// See docs/elected-coordinator.md.

/** How long a leader's lease lasts unless renewed. */
export const PEER_LEASE_MS = 30_000;

/** Start a task's log: the open task as its first state, with nobody leading yet. */
export async function openLog(log: CasLog<Task>, task: Task, entries: LedgerEntry[] = []) {
	const tip = await log.append(null, { term: 0, leader: "", leaseUntil: 0, kind: "genesis", entries, state: task, batch: crypto.randomUUID() });
	if (!tip) {
		const head = await log.read();
		if (head?.commit.state.id === task.id) return head.tip;
		throw new Error(`[409] the log for ${task.id} already exists`);
	}
	return tip;
}

export interface PeerOptions {
	/** The task's log; Git unless a test gives another. */
	log: (taskId: string, repo: string) => CasLog<Task>;
	leaseMs: number;
	now: () => number;
}

export class Peer extends Coordinator {
	private options: PeerOptions = {
		log: (taskId, repo) => new GitCasLog<Task>(() => remoteFor(this.env.ARTIFACTS, repo, "write"), taskId),
		leaseMs: PEER_LEASE_MS,
		now: Date.now,
	};

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
		this.me = me;
		const now = this.options.now();
		// Known without asking Git: this peer leads, or saw a lease that is still live.
		if (this.leader?.leading && this.leader.leaseExpires > now) return { leader: me, term: this.leader.term };
		if (!fresh && this.known && this.known.leaseUntil > now) return { leader: this.known.leader, term: this.known.term };
		const log = this.options.log(taskId, repo);
		const outcome = await campaign(log, me, () => {
			throw new Error(`[404] no task ${taskId} on ${repo}`);
		}, { leaseMs: this.options.leaseMs, now: this.options.now });
		if (!outcome.leading) {
			this.known = { leader: outcome.leader, term: outcome.term, leaseUntil: outcome.leaseUntil };
			return { leader: outcome.leader, term: outcome.term };
		}
		this.known = null;
		this.leader = outcome.leader;
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

	/** Refuse to decide without leading: the caller should ask the peer that does. */
	private leading() {
		if (!this.leader?.leading || !this.working) throw this.leader ? new Deposed(null, this.leader.term) : new Error("[409] no longer leading: this peer does not lead the task");
		return this.working;
	}

	protected override async readTask(): Promise<Task | undefined> {
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
	 * Once this peer's own change has merged or been abandoned, it hands the lead
	 * over: the next peer that needs a decision takes it at once.
	 */
	private async resignIfDone(leader: Leader<Task>, state: Task) {
		const change = this.me?.slice(`${state.id}--`.length);
		const mine = state.slices.find((s) => s.id === change);
		if (!mine || holdsClaim(mine) || !leader.leading) return;
		await leader.resign();
		this.working = null;
	}
}
