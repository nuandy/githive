// The line merges wait in for the project's checks
// (a merge queue). Every merge must be tested on exactly the code it lands
// on, so testing several merges side by side on one main gains nothing: the
// first to land makes the others' results stale. Instead, the merges waiting
// are taken in batches, and each is checked on main with the merges ahead of
// it merged in first, all at once in separate containers. Each
// result says what it was tested after; the merge lands once exactly those
// have landed on that main (see mergeChange), so main is always code that
// was tested. A merge behind one that failed is checked again without it.
// The line decides nothing: it only schedules check runs, and the audit
// checks every merge against what its trailers say it was tested on.

/** How many merges are checked at once, each in its own container. */
export const LANES = 4;
/** How long an idle line waits for more merges before checking the first: merges ready together are checked together. */
export const GATHER_MS = 2_000;
/**
 * The most merges the line checks on top of while they land (its chain): a
 * next batch is checked after all of them, so a longer chain means bigger
 * checks; past it, the line waits for the chain to land.
 */
export const MAX_CHAIN = 8;
/** How long the line waits for its chain to land (or give up) when it has to, before checking on main as it is. */
export const LANDING_WAIT_MS = 3 * 60_000;

export interface LineRequest<I> {
	change: string;
	head: string;
	input: I;
}

export interface LineResult<R> {
	result: R;
	/** The main the checks ran on. */
	base: string;
	/** The merges ahead, in order, merged in before this one: it lands right after them. */
	after: { change: string; head: string }[];
}

export interface LineRunner<I, R extends { passed: boolean }> {
	/** The project's branch head now: a batch with no merges to land ahead of it is checked on it. */
	base(input: I): Promise<string>;
	/** Check `request` on `base` with the merges `ahead` merged in first, in lane `lane`. */
	check(lane: number, request: LineRequest<I>, base: string, ahead: LineRequest<I>[]): Promise<R>;
}

/**
 * The line itself. Batches don't wait for the last one to land: each is
 * checked on the same main as the merges still landing (the chain), with all
 * of them merged in first, so its results stay right as they land. When every
 * merge in the chain has reported back, the next batch starts from main as it
 * is then. A merge in the chain that gives up instead of landing breaks it:
 * everything checked on top of it can't land as checked (those merges check
 * again), so the line lets the rest report back and starts afresh.
 */
export class CheckLine<I, R extends { passed: boolean }> {
	private readonly waiting: (LineRequest<I> & { resolve: (r: LineResult<R>) => void; reject: (err: unknown) => void })[] = [];
	private running = false;
	/** Passing merges handed out and not all reported back, in landing order; and the main they were checked on. */
	private chain: LineRequest<I>[] = [];
	private chainBase: string | null = null;
	private reported = new Set<string>();
	private broken = false;
	private drained?: () => void;

	constructor(
		private readonly runner: LineRunner<I, R>,
		private readonly lanes = LANES,
		private readonly gatherMs = GATHER_MS,
		private readonly landingWaitMs = LANDING_WAIT_MS,
	) {}

	/** Whether the line has work: merges waiting, being checked, or checked and not all reported back. */
	busy() {
		return this.running || this.waiting.length > 0 || this.chain.length > 0;
	}

	/** A merge the line checked is done with its result: it landed, or (landed false) gave up and will check again if it tries again. */
	done(change: string, landed = true) {
		if (!this.chain.some((c) => c.change === change)) return;
		this.reported.add(change);
		if (!landed) this.broken = true;
		if (this.chain.every((c) => this.reported.has(c.change))) {
			this.resetChain();
			this.drained?.();
		}
	}

	private resetChain() {
		this.chain = [];
		this.chainBase = null;
		this.reported.clear();
		this.broken = false;
	}

	/** Until the chain has reported back, or the wait runs out (then it's dropped: merges still on it check again if they must). */
	private async drain() {
		if (!this.chain.length) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.landingWaitMs);
			this.drained = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.drained = undefined;
		this.resetChain();
	}

	/** Join the line; resolves with this merge's checks, once they've run. */
	join(request: LineRequest<I>): Promise<LineResult<R>> {
		return new Promise((resolve, reject) => {
			// A newer request for the same change replaces one still waiting (a new head was pushed).
			const stale = this.waiting.findIndex((w) => w.change === request.change);
			if (stale >= 0) this.waiting.splice(stale, 1)[0].reject(new Error(`[409] ${request.change} joined the line again with ${request.head.slice(0, 8)}`));
			this.waiting.push({ ...request, resolve, reject });
			void this.run();
		});
	}

	/** How many merges are waiting (not yet in a batch). */
	get length() {
		return this.waiting.length;
	}

	private async run() {
		if (this.running) return;
		this.running = true;
		try {
			await new Promise((resolve) => setTimeout(resolve, this.gatherMs));
			while (this.waiting.length) {
				// A broken or long chain: let it land first, then start from main.
				if (this.broken || this.chain.length >= MAX_CHAIN) await this.drain();
				const batch = this.waiting.splice(0, this.lanes);
				const ahead = [...this.chain];
				let base: string;
				let results: R[];
				try {
					base = this.chainBase ?? (await this.runner.base(batch[0].input));
					results = await Promise.all(batch.map((request, i) => this.runner.check(i, request, base, [...ahead, ...batch.slice(0, i)])));
				} catch (err) {
					for (const w of batch) w.reject(err);
					continue;
				}
				// In order: each passing merge lands after the chain and the ones before it. Behind a
				// failure, the results included the failed merge, so those merges wait again, first in line.
				const after = ahead.map((c) => ({ change: c.change, head: c.head }));
				const again: typeof batch = [];
				let failed = false;
				for (const [i, w] of batch.entries()) {
					if (failed) {
						again.push(w);
						continue;
					}
					w.resolve({ result: results[i], base, after: [...after] });
					if (results[i].passed) {
						after.push({ change: w.change, head: w.head });
						this.chain.push({ change: w.change, head: w.head, input: w.input });
						this.chainBase = base;
					} else failed = true;
				}
				this.waiting.unshift(...again);
			}
		} finally {
			this.running = false;
		}
	}
}
