// The line merges wait in for the project's checks, in coordinator-free mode
// (a merge queue). Every merge must be tested on exactly the code it lands
// on, so testing several merges side by side on one main gains nothing: the
// first to land makes the others' results stale. Instead, the merges waiting
// are taken in batches, and each is checked on main with the merges ahead of
// it in the batch merged in first, all at once in separate containers. Each
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
 * How long the line waits for a batch's passing merges to land (or give up)
 * before checking the next batch on main: checked on main without them, the
 * next batch's results would go stale the moment they land.
 */
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
	/** The project's branch head now: each batch is checked on it. */
	base(input: I): Promise<string>;
	/** Check `request` on `base` with the merges `ahead` merged in first, in lane `lane`. */
	check(lane: number, request: LineRequest<I>, base: string, ahead: LineRequest<I>[]): Promise<R>;
}

export class CheckLine<I, R extends { passed: boolean }> {
	private readonly waiting: (LineRequest<I> & { resolve: (r: LineResult<R>) => void; reject: (err: unknown) => void })[] = [];
	private running = false;
	/** The last batch's passing merges that haven't landed or given up yet. */
	private landing = new Set<string>();
	private landed?: () => void;

	constructor(
		private readonly runner: LineRunner<I, R>,
		private readonly lanes = LANES,
		private readonly gatherMs = GATHER_MS,
		private readonly landingWaitMs = LANDING_WAIT_MS,
	) {}

	/** A merge the line checked is done with its result: it landed, or gave up (it checks again if it tries again). */
	done(change: string) {
		this.landing.delete(change);
		if (!this.landing.size) this.landed?.();
	}

	/** Until the last batch's passing merges have landed or given up, or the wait runs out. */
	private async awaitLandings() {
		if (!this.landing.size) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.landingWaitMs);
			this.landed = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.landed = undefined;
		this.landing.clear();
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
				await this.awaitLandings();
				const batch = this.waiting.splice(0, this.lanes);
				let base: string;
				let results: R[];
				try {
					base = await this.runner.base(batch[0].input);
					results = await Promise.all(batch.map((request, i) => this.runner.check(i, request, base, batch.slice(0, i))));
				} catch (err) {
					for (const w of batch) w.reject(err);
					continue;
				}
				// In order: each passing merge lands after the ones before it. Behind a failure,
				// the results included the failed merge, so those merges wait again, first in line.
				const after: { change: string; head: string }[] = [];
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
						this.landing.add(w.change);
					}
					else failed = true;
				}
				this.waiting.unshift(...again);
			}
		} finally {
			this.running = false;
		}
	}
}
