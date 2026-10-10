#!/usr/bin/env node
// Finds the batch size that spends the fewest check runs, landing batches the
// way GitHive does (src/toolkit/merge.ts, checkBatch). A failing batch is split
// in halves, checked side by side, until parts pass. A failing single change is
// checked once more, then put out. Only the shallowest passing part lands; the
// others return to the front of the pool, since each was checked on main alone.
//
//   node scripts/batch-size-sim.mjs [--fail 0.01,0.02,0.05,0.1,0.2]
//                                   [--sizes 4,6,8,12,16,20,24,32,48,64]
//                                   [--batches 40000] [--seed 1]
//
// For each failure share and batch size, prints check runs per settled change
// and changes settled per unit of search time. Bad changes always fail, a full
// batch is always waiting, and every run takes the same time.

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const fails = (flag("fail") ?? "0.01,0.02,0.05,0.1,0.2").split(",").map(Number);
const sizes = (flag("sizes") ?? "4,6,8,12,16,20,24,32,48,64").split(",").map(Number);
const BATCHES = Number(flag("batches") ?? 40000);
const SEED = Number(flag("seed") ?? 1);

// Seeded (mulberry32), so every size sees the same changes.
const seeded = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** GitHive's batch size for a failure share (merge.ts, batchSize, without the prior). */
const githiveSize = (p) => Math.max(4, Math.min(64, Math.round(1 / p)));

/** Searches `batch` (true marks a bad change) as checkBatch does, collecting passing parts and put-out changes. */
function search(batch, depth, found, out, runs) {
	runs.n++;
	if (!batch.some(Boolean)) return void found.push({ depth, part: batch });
	if (batch.length === 1) return void (runs.n++, out.push(batch[0]));
	const half = Math.ceil(batch.length / 2);
	search(batch.slice(0, half), depth + 1, found, out, runs);
	search(batch.slice(half), depth + 1, found, out, runs);
}

/** Simulates batches of `n` from a stream where a share `p` of changes fail. */
function steady(n, p) {
	const random = seeded(SEED);
	let pool = [];
	const runs = { n: 0 };
	let settled = 0;
	let time = 0;
	for (let i = 0; i < BATCHES; i++) {
		while (pool.length < n) pool.push(random() < p);
		const batch = pool.slice(0, n);
		pool = pool.slice(n);
		const found = [];
		const out = [];
		search(batch, 0, found, out, runs);
		settled += out.length;
		// The search takes as long as its deepest part, plus a failing change's second run.
		const deepest = Math.max(0, ...found.map((f) => f.depth));
		time += 1 + (out.length ? Math.max(deepest, Math.ceil(Math.log2(n))) + 1 : 0);
		if (found.length) {
			found.sort((a, b) => a.depth - b.depth);
			settled += found[0].part.length;
			pool = [...found.slice(1).flatMap((f) => f.part), ...pool];
		}
	}
	return { runsPerChange: runs.n / settled, perTime: settled / time };
}

const cell = (x) => x.toFixed(3).padStart(7);
const results = fails.map((p) => ({ p, at: sizes.map((n) => steady(n, p)) }));

console.log("Check runs per change landed or put out\n");
console.log(`${"fail".padEnd(6)}${sizes.map((n) => String(n).padStart(7)).join("")}   fewest at   GitHive (1/p)`);
for (const { p, at } of results) {
	const costs = at.map((r) => r.runsPerChange);
	const best = sizes[costs.indexOf(Math.min(...costs))];
	const columns = costs.map(cell).join("");
	console.log(
		`${String(p).padEnd(6)}${columns}   ${String(best).padStart(9)}   ${String(githiveSize(p)).padStart(13)}`,
	);
}

console.log("\nChanges landed or put out per check's time (one merge landing batches)\n");
console.log(`${"fail".padEnd(6)}${sizes.map((n) => String(n).padStart(7)).join("")}`);
for (const { p, at } of results)
	console.log(`${String(p).padEnd(6)}${at.map((r) => r.perTime.toFixed(2).padStart(7)).join("")}`);

console.log("\nGitHive's size against the fewest runs\n");
for (const { p } of results) {
	const size = githiveSize(p);
	const all = [...new Set([...sizes, size])].map((n) => ({ n, ...steady(n, p) }));
	const best = all.reduce((a, b) => (b.runsPerChange < a.runsPerChange ? b : a));
	const ours = all.find((r) => r.n === size);
	const pct = (x) => `${x >= 0 ? "+" : ""}${Math.round(100 * x)}%`;
	console.log(
		`fail ${p}: fewest at ${best.n}; at ${size}, ${pct(ours.runsPerChange / best.runsPerChange - 1)} ` +
			`runs, ${pct(ours.perTime / best.perTime - 1)} changes per time`,
	);
}
