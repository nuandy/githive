#!/usr/bin/env node
// Simulate ways of lining merges up for checks, on the same stream of
// changes, and compare what each spends on checks and how long a change
// waits to land. Nothing here touches a repo: changes arrive at random, some
// are bad, checks take minutes and sometimes fail for no reason, and each way
// of queuing decides what to check, on what, and what lands.
//
//   node scripts/queue-sim.mjs [--rate 20] [--fail 0.05] [--flaky 0.01] [--ci 10]
//                              [--runners 8] [--hours 24] [--seeds 5]
//                              [--only githive,github,...] [--sweep rate=10,20,40]
//                              [--retry on|off] [--lanes N]
//
//   --rate     changes arriving per hour
//   --fail     chance a change is bad (its checks fail with it in, every time)
//   --flaky    chance a check of only good changes fails anyway
//   --ci       minutes a check takes (each one 80-120% of that)
//   --runners  checks that can run at once (the GitHive line ignores this:
//              every merge checks in its own container)
//   --hours    how long changes keep arriving; then the queues drain
//   --seeds    runs per way, pooled (the same seeds for every way)
//   --sweep    run every way once per value of one setting
//   --retry    check every culprit again (on) or none (off), whatever the way does
//   --lanes    split every way into N lanes
//
// The ways:
//   githive         the line today (src/toolkit/line.ts): one change per place,
//                   at most 8, each checked after everything ahead. Behind a
//                   failure, a merge finishes its check, then joins again at
//                   the end; failing on its 4th try in a row is its own failure.
//   github          GitHub's merge queue: the same, but checks behind a failure
//                   are cancelled and rebuilt in place.
//   github-lenient  and a later group passing lands the groups ahead of it.
//   bisect          one batch at a time (about 1/failure-rate changes), checked
//                   whole; red, a binary search finds the first failing prefix,
//                   lands what's before it and puts the rest back.
//   kary            the same, searching with every runner at once.
//   hybrid          up to 3 batches checked at once, each on the ones ahead; a
//                   red head leaves the line to be bisected aside, and the line
//                   goes on without it. (Binary: wider searches spend runners the
//                   line needs, and aside, more rounds only delay the red batch.)
//   hybrid-lanes    hybrid, with changes split into 4 lanes that can't break
//                   each other (as if split by what they touch).
//
// A check fails if any change in it is bad, so a change that only breaks
// alongside another one is found the same way: the first prefix that fails.
// The new ways check a culprit again before putting it out (a flaky failure
// costs one more check, not a good change); GitHub's and the line don't.

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const base = {
	rate: Number(flag("rate") ?? 20),
	fail: Number(flag("fail") ?? 0.05),
	flaky: Number(flag("flaky") ?? 0.01),
	ci: Number(flag("ci") ?? 10),
	runners: Number(flag("runners") ?? 8),
	hours: Number(flag("hours") ?? 24),
	seeds: Number(flag("seeds") ?? 5),
	retry: flag("retry"),
	lanes: flag("lanes") && Number(flag("lanes")),
};

/** How each way queues, as settings of the one simulated line. */
const WAYS = {
	githive: (c) => ({ batch: 1, depth: 8, k: 1, cancel: false, displaced: "back", tries: 4, ownContainers: true }),
	github: (c) => ({ batch: 1, depth: c.runners, k: 1, cancel: true, displaced: "front" }),
	"github-lenient": (c) => ({ batch: 1, depth: c.runners, k: 1, cancel: true, displaced: "front", lenient: true }),
	bisect: (c) => ({ batch: "adaptive", depth: 1, k: 1, cancel: true, displaced: "front", retry: true, pause: true }),
	kary: (c) => ({ batch: "adaptive", depth: 1, k: c.runners, cancel: true, displaced: "front", retry: true, pause: true }),
	hybrid: (c) => ({ batch: "adaptive", depth: 3, k: 1, cancel: true, displaced: "front", retry: true, pause: true, aside: true }),
	"hybrid-lanes": (c) => ({ batch: "adaptive", depth: 3, k: 1, cancel: true, displaced: "front", retry: true, pause: true, aside: true, lanes: 4 }),
};
/** The biggest batch the adaptive ways make. */
const MAX_BATCH = 64;
/** How fast the failure rate a batch size is picked from follows what's been seen. */
const LEARN = 0.05;

// Seeded (mulberry32), so every way sees the same changes for a seed.
const seeded = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Events by time, earliest first. */
class Events {
	heap = [];
	seq = 0;
	push(time, fn) {
		const h = this.heap;
		h.push({ time, seq: this.seq++, fn });
		for (let i = h.length - 1; i > 0; ) {
			const p = (i - 1) >> 1;
			if (!this.before(h[i], h[p])) break;
			[h[i], h[p]] = [h[p], h[i]];
			i = p;
		}
	}
	pop() {
		const h = this.heap;
		const top = h[0];
		const last = h.pop();
		if (h.length) {
			h[0] = last;
			for (let i = 0; ; ) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < h.length && this.before(h[l], h[m])) m = l;
				if (r < h.length && this.before(h[r], h[m])) m = r;
				if (m === i) break;
				[h[i], h[m]] = [h[m], h[i]];
				i = m;
			}
		}
		return top;
	}
	before(a, b) {
		return a.time < b.time || (a.time === b.time && a.seq < b.seq);
	}
}

/** One run of one way: changes arrive, are checked, land or are put out. */
function simulate(c, way, seed) {
	const random = seeded(seed);
	const events = new Events();
	const sim = { now: 0, free: way.ownContainers ? Infinity : c.runners, checks: 0, minutes: 0 };
	const changes = [];
	const lanes = Array.from({ length: way.lanes ?? 1 }, () => new Line(sim, way, c.fail));

	/** Start a check of `state` for `line`, if a runner is free. */
	sim.start = (line, what, state) => {
		if (sim.free <= 0) return null;
		sim.free--;
		sim.checks++;
		const job = { line, what, state, start: sim.now, cancelled: false };
		events.push(sim.now + c.ci * (0.8 + 0.4 * random()), () => {
			if (job.cancelled) return;
			sim.free++;
			sim.minutes += sim.now - job.start;
			job.line.done(job, !state.some((ch) => ch.bad) && random() >= c.flaky);
		});
		return job;
	};
	sim.cancel = (job) => {
		job.cancelled = true;
		sim.free++;
		sim.minutes += sim.now - job.start;
	};

	// Arrivals: a Poisson stream for c.hours.
	for (let t = 0, id = 0; ; id++) {
		t += (-Math.log(1 - random()) * 60) / c.rate;
		if (t > c.hours * 60) break;
		const change = { id, arrived: t, bad: random() < c.fail, lane: Math.floor(random() * lanes.length), attempt: 0 };
		changes.push(change);
		events.push(t, () => lanes[change.lane].pending.push(change));
	}

	const settle = () => {
		for (const line of lanes) line.form();
		for (const line of lanes) line.fill(true);
		for (const line of lanes) line.fill(false);
	};
	const limit = c.hours * 60 * 4;
	while (events.heap.length) {
		const event = events.pop();
		if (event.time > limit) break;
		sim.now = event.time;
		event.fn();
		settle();
	}
	return { changes, checks: sim.checks, minutes: sim.minutes };
}

/**
 * A line into one branch (or one lane of it). Batches are checked in order,
 * each on the trunk with every batch ahead of it merged in first; the head
 * lands when its check passes. A red head is searched for the first failing
 * prefix: the green prefix before it lands, its last change is put out, the
 * rest go back to wait. Searched aside, the red batch leaves the line, which
 * goes on without it; once the culprit is out, the rest go back to wait (what
 * passed was checked on a trunk that has moved since).
 */
class Line {
	pending = [];
	batches = [];
	/** The head's search in place, while it's red: prefix `lo` passed, prefix `hi` failed. */
	search = null;
	/** Searches of red batches taken out of the line. */
	aside = [];
	constructor(sim, way, prior) {
		this.sim = sim;
		this.way = way;
		this.failRate = prior;
	}

	size() {
		return this.way.batch === 1 ? 1 : Math.max(1, Math.min(MAX_BATCH, Math.round(1 / Math.max(this.failRate, 1 / MAX_BATCH))));
	}

	/** What batch `i`'s check runs on: every change ahead of it, then its own. */
	stateOf(i) {
		return this.batches.slice(0, i + 1).flatMap((b) => b.changes);
	}

	form() {
		while (!this.search && this.batches.length < this.way.depth && this.pending.length) {
			const changes = this.pending.splice(0, this.size());
			for (const ch of changes) ch.attempt++;
			this.batches.push({ changes, status: "new", job: null });
		}
	}

	/** Start checks: the searches' and the head's when `urgent`, else the ones behind it. */
	fill(urgent) {
		if (urgent) {
			for (const s of this.search ? [this.search, ...this.aside] : this.aside) {
				for (const probe of s.round) {
					if (probe.job || probe.passed !== undefined) continue;
					probe.job = this.sim.start(this, { probe }, s.changes.slice(0, probe.at));
					if (!probe.job) return;
				}
			}
			if (!this.search && this.batches[0]?.status === "new") this.check(0);
			return;
		}
		if (this.search) return;
		for (let i = 1; i < this.batches.length; i++) {
			if (this.way.pause && this.batches[i - 1].status === "red") return;
			if (this.batches[i].status === "new" && !this.check(i)) return;
		}
	}

	check(i) {
		const batch = this.batches[i];
		batch.job = this.sim.start(this, { batch }, this.stateOf(i));
		if (batch.job) batch.status = "checking";
		return batch.job;
	}

	done(job, passed) {
		if (job.what.probe) return this.probed(job.what.probe, passed);
		const batch = job.what.batch;
		batch.job = null;
		if (batch.status === "orphan") return this.orphaned(batch, passed);
		const i = this.batches.indexOf(batch);
		batch.status = passed ? "green" : "red";
		if (passed && this.way.lenient) {
			for (const b of this.batches.splice(0, i + 1)) {
				if (b.job) this.sim.cancel(b.job);
				this.land(b.changes);
			}
		}
		// The line: a merge failing its 4th try in a row takes it as its own, whatever's ahead.
		if (!passed && i > 0 && this.way.tries && batch.changes[0].attempt >= this.way.tries) {
			this.batches.splice(i, 1);
			this.putOut(batch.changes[0]);
			this.displace(i);
		}
		this.advance();
	}

	/** Behind a failure, the line lets a merge finish its check before it joins again, at the end. */
	orphaned(batch, passed) {
		const [ch] = batch.changes;
		if (passed) ch.attempt = 0;
		else if (ch.attempt >= this.way.tries) return this.putOut(ch);
		this.pending.push(ch);
	}

	advance() {
		while (!this.search && this.batches[0]) {
			const head = this.batches[0];
			if (head.status === "green") {
				this.batches.shift();
				this.land(head.changes);
			} else {
				if (head.status === "red") this.headFailed();
				return;
			}
		}
	}

	headFailed() {
		const { changes } = this.batches[0];
		const s = { changes, lo: 0, hi: changes.length, round: [], retried: false };
		if (this.way.aside) {
			this.batches.shift();
			this.displace(0);
			this.aside.push(s);
		} else {
			this.displace(1);
			this.search = s;
		}
		this.narrow(s);
	}

	/** The next round of a search: up to k prefixes between lo and hi, or the culprit found. */
	narrow(s) {
		if (s.hi - s.lo > 1) {
			const at = new Set();
			for (let j = 1; j <= this.way.k; j++) at.add(s.lo + Math.round(((s.hi - s.lo) * j) / (this.way.k + 1)));
			s.round = [...at].filter((p) => p > s.lo && p < s.hi).map((p) => ({ at: p, search: s }));
		} else if (this.way.retry && !s.retried) {
			s.retried = true;
			s.round = [{ at: s.hi, search: s, retry: true }];
		} else this.resolve(s, s.lo, true);
	}

	probed(probe, passed) {
		probe.job = null;
		probe.passed = passed;
		const s = probe.search;
		if (s.round.some((p) => p.passed === undefined)) return;
		if (probe.retry) return this.resolve(s, passed ? s.hi : s.lo, !passed);
		const red = s.round.filter((p) => !p.passed).map((p) => p.at);
		if (red.length) s.hi = Math.min(...red);
		const green = s.round.filter((p) => p.passed && p.at < s.hi).map((p) => p.at);
		if (green.length) s.lo = Math.max(s.lo, ...green);
		this.narrow(s);
	}

	/**
	 * The first `lo` changes passed: in place, they land; aside, they were
	 * checked on a trunk that's moved since, so they go back to wait. The next
	 * one is put out if it's the `culprit`, and the rest go back to wait.
	 */
	resolve(s, lo, culprit) {
		const rest = s.changes.slice(lo + (culprit ? 1 : 0));
		if (culprit) this.putOut(s.changes[lo]);
		if (s === this.search) {
			this.search = null;
			this.batches.shift();
			this.land(s.changes.slice(0, lo));
			this.pending.unshift(...rest);
		} else {
			this.aside.splice(this.aside.indexOf(s), 1);
			this.pending.unshift(...s.changes.slice(0, lo), ...rest);
		}
		this.advance();
	}

	/** Take batches from `from` on out of the line: they were checked on what's now changed. */
	displace(from) {
		const back = [];
		for (const b of this.batches.splice(from)) {
			if (b.job && !this.way.cancel) {
				b.status = "orphan";
				continue;
			}
			if (b.job) this.sim.cancel(b.job);
			if (b.status === "green") for (const ch of b.changes) ch.attempt = 0;
			back.push(...b.changes);
		}
		if (this.way.displaced === "back") this.pending.push(...back);
		else this.pending.unshift(...back);
	}

	land(changes) {
		for (const ch of changes) {
			ch.landed = this.sim.now;
			this.failRate *= 1 - LEARN;
		}
	}

	putOut(ch) {
		ch.out = this.sim.now;
		this.failRate = this.failRate * (1 - LEARN) + LEARN;
	}
}

const pct = (xs, q) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mins = (m) => (Number.isNaN(m) ? "-" : m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`);

function compare(c, names) {
	const rows = names.map((name) => {
		const way = { ...WAYS[name](c), ...(c.retry ? { retry: c.retry === "on" } : {}), ...(c.lanes ? { lanes: c.lanes } : {}) };
		let checks = 0;
		let minutes = 0;
		const all = [];
		for (let s = 1; s <= c.seeds; s++) {
			const run = simulate(c, way, s * 7919);
			checks += run.checks;
			minutes += run.minutes;
			all.push(...run.changes);
		}
		const landed = all.filter((ch) => ch.landed !== undefined);
		const good = all.filter((ch) => !ch.bad);
		const bad = all.filter((ch) => ch.bad);
		const left = all.filter((ch) => ch.landed === undefined && ch.out === undefined).length;
		const wait = landed.map((ch) => ch.landed - ch.arrived);
		return [
			name,
			(checks / landed.length).toFixed(2),
			Math.round(minutes / landed.length).toString(),
			mins(pct(wait, 0.5)),
			mins(pct(wait, 0.95)),
			mins(pct(bad.filter((ch) => ch.out !== undefined).map((ch) => ch.out - ch.arrived), 0.5)),
			good.length ? `${((100 * good.filter((ch) => ch.out !== undefined).length) / good.length).toFixed(1)}%` : "-",
			left ? `${Math.round(left / c.seeds)}` : "0",
		];
	});
	const head = ["way", "checks/landed", "CI min/landed", "land p50", "land p95", "bad out p50", "good put out", "never done"];
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (r) => r.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ");
	console.log(line(head));
	for (const r of rows) console.log(line(r));
}

const names = flag("only")?.split(",") ?? Object.keys(WAYS);
for (const n of names) if (!WAYS[n]) throw new Error(`no way called ${n}: ${Object.keys(WAYS).join(", ")}`);
const describe = (c) =>
	`${c.rate}/h arriving for ${c.hours}h, ${c.fail * 100}% bad, ${c.flaky * 100}% flaky, ${c.ci}m checks, ${c.runners} runners, ${c.seeds} seeds` +
	(c.retry ? `, retry ${c.retry}` : "") +
	(c.lanes ? `, ${c.lanes} lanes` : "");
const sweep = flag("sweep");
if (sweep) {
	const [key, values] = sweep.split("=");
	if (!(key in base)) throw new Error(`can't sweep ${key}: ${Object.keys(base).join(", ")}`);
	for (const v of values.split(",")) {
		const c = { ...base, [key]: Number(v) };
		console.log(`\n${key} = ${v}  (${describe(c)})`);
		compare(c, names);
	}
} else {
	console.log(describe(base));
	compare(base, names);
}
