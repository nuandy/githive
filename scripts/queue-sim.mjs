#!/usr/bin/env node
// Simulates ways of queuing merges for checks on the same stream of changes,
// and compares check cost and time to land. Nothing touches a repo. Changes
// arrive at random, some are bad, and checks take minutes and sometimes flake.
//
//   node scripts/queue-sim.mjs [--rate 20] [--fail 0.05] [--flaky 0.01] [--ci 10]
//                              [--runners 8] [--hours 24] [--seeds 5]
//                              [--only githive,github,...] [--sweep rate=10,20,40]
//                              [--retry on|off] [--lanes N]
//
//   --rate     changes arriving per hour
//   --fail     chance a change is bad (checks containing it always fail)
//   --flaky    chance a check of only good changes fails anyway
//   --ci       minutes per check (each takes 80-120% of that)
//   --runners  checks that can run at once (ignored by githive, which uses a container per merge)
//   --hours    how long changes keep arriving before the queues drain
//   --seeds    runs per way, pooled; every way gets the same seeds
//   --sweep    run every way once per value of one setting
//   --retry    recheck every culprit (on) or none (off), overriding the way
//   --lanes    split every way into N lanes
//
// The ways:
//   githive         GitHive's former line (since replaced by set landing): one change
//                   per place, at most 8, each checked on everything ahead. A merge
//                   behind a failure rejoins at the end; a 4th failure in a row is its own.
//   github          GitHub's merge queue: checks behind a failure are cancelled and rebuilt.
//   github-lenient  github, but a later passing group lands the groups ahead of it.
//   bisect          one batch at a time, checked whole. On failure, a binary search
//                   finds the first failing prefix and lands what precedes it.
//   kary            bisect, searching with every runner at once.
//   hybrid          up to 3 batches checked at once, each on those ahead. A failing
//                   head is bisected aside while the line continues.
//   hybrid-lanes    hybrid, with changes split into 4 independent lanes.
//
// A check fails if any change in it is bad. The new ways recheck a culprit
// before removing it, so a flake costs one check rather than a good change.

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
	kary: (c) => ({
		batch: "adaptive",
		depth: 1,
		k: c.runners,
		cancel: true,
		displaced: "front",
		retry: true,
		pause: true,
	}),
	hybrid: (c) => ({
		batch: "adaptive",
		depth: 3,
		k: 1,
		cancel: true,
		displaced: "front",
		retry: true,
		pause: true,
		aside: true,
	}),
	"hybrid-lanes": (c) => ({
		batch: "adaptive",
		depth: 3,
		k: 1,
		cancel: true,
		displaced: "front",
		retry: true,
		pause: true,
		aside: true,
		lanes: 4,
	}),
};
/** The biggest batch the adaptive ways make. */
const MAX_BATCH = 64;
/** How quickly the estimated failure rate, which sets the batch size, tracks observed failures. */
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
		for (let i = h.length - 1; i > 0;) {
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
			for (let i = 0; ;) {
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

/** Runs one way once: changes arrive, are checked, and land or are put out. */
function simulate(c, way, seed) {
	const random = seeded(seed);
	const events = new Events();
	const sim = { now: 0, free: way.ownContainers ? Infinity : c.runners, checks: 0, minutes: 0 };
	const changes = [];
	const lanes = Array.from({ length: way.lanes ?? 1 }, () => new Line(sim, way, c.fail));

	/** Starts a check of `state` for `line` if a runner is free. */
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
 * A line into one branch or lane. Each batch is checked on the trunk plus every
 * batch ahead of it, and the head lands when its check passes. A failing head is
 * searched for its first failing prefix. The passing prefix lands, the culprit is
 * put out, and the rest wait again. A batch searched aside leaves the line, and
 * its passing prefix waits again too, since the trunk has moved since its check.
 */
class Line {
	pending = [];
	batches = [];
	/** The failing head's search in place. Prefix `lo` passed and prefix `hi` failed. */
	search = null;
	/** Searches of red batches taken out of the line. */
	aside = [];
	constructor(sim, way, prior) {
		this.sim = sim;
		this.way = way;
		this.failRate = prior;
	}

	size() {
		return this.way.batch === 1
			? 1
			: Math.max(1, Math.min(MAX_BATCH, Math.round(1 / Math.max(this.failRate, 1 / MAX_BATCH))));
	}

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

	/** Starts the searches' and head's checks when `urgent`, otherwise the checks behind the head. */
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
		// In the githive way, a merge that fails `tries` times in a row counts as its own failure.
		if (!passed && i > 0 && this.way.tries && batch.changes[0].attempt >= this.way.tries) {
			this.batches.splice(i, 1);
			this.putOut(batch.changes[0]);
			this.displace(i);
		}
		this.advance();
	}

	/** A merge displaced by a failure finishes its check, then rejoins at the end. */
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

	/** Starts the next search round of up to k prefixes between lo and hi, or resolves the culprit. */
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
	 * The first `lo` changes passed. In place they land; aside they wait again
	 * because the trunk has moved. The next change is put out if it is the culprit.
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

	/** Removes batches from `from` onward, whose checks ran on a state that has changed. */
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
const mins = (m) => {
	if (Number.isNaN(m)) return "-";
	if (m < 60) return `${Math.round(m)}m`;
	return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;
};

function compare(c, names) {
	const rows = names.map((name) => {
		const way = {
			...WAYS[name](c),
			...(c.retry ? { retry: c.retry === "on" } : {}),
			...(c.lanes ? { lanes: c.lanes } : {}),
		};
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
			mins(
				pct(
					bad.filter((ch) => ch.out !== undefined).map((ch) => ch.out - ch.arrived),
					0.5,
				),
			),
			good.length ? `${((100 * good.filter((ch) => ch.out !== undefined).length) / good.length).toFixed(1)}%` : "-",
			left ? `${Math.round(left / c.seeds)}` : "0",
		];
	});
	const head = [
		"way",
		"checks/landed",
		"CI min/landed",
		"land p50",
		"land p95",
		"bad out p50",
		"good put out",
		"never done",
	];
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (r) => r.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ");
	console.log(line(head));
	for (const r of rows) console.log(line(r));
}

const names = flag("only")?.split(",") ?? Object.keys(WAYS);
for (const n of names) if (!WAYS[n]) throw new Error(`no way called ${n}: ${Object.keys(WAYS).join(", ")}`);
const describe = (c) =>
	`${c.rate}/h arriving for ${c.hours}h, ${c.fail * 100}% bad, ${c.flaky * 100}% flaky, ${c.ci}m checks, ${c.runners} ` +
	`runners, ${c.seeds} seeds` +
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
