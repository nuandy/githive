import { remoteFor } from "./artifacts";
import { statusOf } from "./errors";
import { type LedgerDoc, type LedgerEntry, diff, toDoc } from "./ledger";
import { appendLedger } from "./ledger-git";
import type { Task } from "./types";

// The Coordinator's record in Git, written in the background. Each locked
// step's decisions go to a durable outbox in storage when the step ends; one
// writer at a time appends them, with the state change since the last write,
// to the task's notes ref.

/**
 * One call through the Coordinator's lock: what it was, when it queued, and
 * milliseconds spent waiting, running, and queueing its decisions for the ledger.
 */
export interface LockSample {
	label: string;
	at: number;
	waitMs: number;
	runMs: number;
	flushMs: number;
}

const MAX_LOCK_SAMPLES = 5_000;

/** Keep the newest `max` items of a list, in place. */
const keepLast = <T>(list: T[], max: number) => {
	if (list.length > max) list.splice(0, list.length - max);
};

/** Lock timings and ledger lags, for benchmarks. Kept in memory only, so they reset when the object restarts. */
export class LockStats {
	/** Recent lock timings. */
	private samples: LockSample[] = [];

	/** For decisions written to Git since the last reset: milliseconds from the decision to its write. */
	private ledgerLags: number[] = [];

	/** Calls waiting for or holding the lock right now. */
	depth = 0;

	record(sample: LockSample) {
		this.samples.push(sample);
		keepLast(this.samples, MAX_LOCK_SAMPLES);
	}

	recordLags(lags: number[]) {
		this.ledgerLags.push(...lags);
		keepLast(this.ledgerLags, MAX_LOCK_SAMPLES);
	}

	/** Timings since the last reset, oldest first. */
	read(reset = false) {
		const samples = this.samples;
		const ledgerLagMs = this.ledgerLags;
		if (reset) {
			this.samples = [];
			this.ledgerLags = [];
		}
		return { samples, ledgerLagMs, inFlight: this.depth };
	}
}

export class LedgerOutbox {
	/** Decisions made by the running step, queued when it finishes. */
	private entries: LedgerEntry[] = [];

	/** The background write in progress, and whether more was queued while it ran. */
	private flushing: Promise<void> | null = null;
	private flushAgain = false;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
		private readonly stats: LockStats,
	) {}

	/** Record a decision of the running step. */
	add(entry: LedgerEntry) {
		this.entries.push(entry);
	}

	/** Drop the running step's decisions: it failed, or the task is gone. */
	discard() {
		this.entries = [];
	}

	/**
	 * Add the step's decisions to the durable outbox and start the background
	 * write. Caller holds the lock; this only touches local storage.
	 */
	async queue() {
		const entries = this.entries;
		this.entries = [];
		if (entries.length) {
			const pending = (await this.ctx.storage.get<LedgerEntry[]>("ledger:pending")) ?? [];
			await this.ctx.storage.put("ledger:pending", [...pending, ...entries]);
		}
		this.kick();
	}

	/** Start the writer unless it is running; if it is, it goes round again when done. */
	private kick() {
		if (this.flushing) {
			this.flushAgain = true;
			return;
		}
		this.flushing = (async () => {
			try {
				do this.flushAgain = false;
				while ((await this.write()) && this.flushAgain);
			} finally {
				this.flushing = null;
			}
		})();
		this.ctx.waitUntil?.(this.flushing);
	}

	/**
	 * Append the queued decisions and the state change since the last write to
	 * the task's notes ref, as one commit. Only one write runs at a time, so a
	 * burst of decisions goes out in a few commits instead of one each. If Git
	 * can't be reached, everything stays queued and goes out with the next write:
	 * the patch is always taken from the last recorded state. Returns whether
	 * the write succeeded (or there was nothing to write).
	 */
	private async write() {
		const [task, contracts, recorded, pending] = await Promise.all([
			this.ctx.storage.get<Task>("task"),
			this.ctx.storage.get<Record<string, string>>("contracts"),
			this.ctx.storage.get<LedgerDoc>("ledger:doc"),
			this.ctx.storage.get<LedgerEntry[]>("ledger:pending"),
		]);
		if (!task) return true;
		const doc = toDoc(task, contracts ?? {});
		const patch = diff(recorded ?? {}, doc);
		const batch = pending ?? [];
		if (patch === undefined && !batch.length) return true;
		try {
			await appendLedger(await remoteFor(this.env.ARTIFACTS, task.repo, "write"), task.id, batch, patch);
		} catch (err) {
			console.error(`ledger write for task ${task.id} failed: ${statusOf(err).message}`, err);
			return false;
		}
		// Decisions queued during the write stay queued for the next one.
		const now = (await this.ctx.storage.get<LedgerEntry[]>("ledger:pending")) ?? [];
		await this.ctx.storage.put({ "ledger:doc": doc, "ledger:pending": now.slice(batch.length) });
		const written = Date.now();
		this.stats.recordLags(batch.map((e) => written - Date.parse(e.at)));
		return true;
	}

	/** Wait until every queued decision is in Git, retrying a failed write once. Returns how many are still queued. */
	async idle() {
		for (let attempt = 0; attempt < 2; attempt++) {
			while (this.flushing) await this.flushing;
			const pending = (await this.ctx.storage.get<LedgerEntry[]>("ledger:pending")) ?? [];
			if (!pending.length) return 0;
			this.kick();
		}
		while (this.flushing) await this.flushing;
		return ((await this.ctx.storage.get<LedgerEntry[]>("ledger:pending")) ?? []).length;
	}
}
