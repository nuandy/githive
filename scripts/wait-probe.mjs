#!/usr/bin/env node
// Measures what agents in `wait` cost while others write (step 6 of the notifications proposal): in a scratch repo it
// makes, `--waiters` agents call `wait` again and again, each with its last `seen`, while `--writers` agents each make
// a steady round of writes: a claim, a vote on it from another writer, then its release. Under rings that say whom they
// concern, a claim wakes no waiting agent, a vote only its change's agent and its voter, and a release everyone; before
// them, every write woke every waiting agent. Afterwards it reads, from Cloudflare's analytics, what each Durable
// Object class did in the run's window, and divides by the writes. Run it on a build without the change and on one
// with it, with `--label` to tell them apart; results go to bench-results/notifications/.
//
//   node scripts/wait-probe.mjs --label before [--waiters 50] [--writers 5] [--minutes 3] [--base URL] [--owner nuandy]
//
// With `--ladder 0,250,1000` it runs a stage for each number of waiting agents, one after another in the same repo and
// with the same writers, and says for each how long calls took (p50, p95, most) and how soon a release woke the waiting
// agents: if those grow with the waiters while the writers stay the same, the repo's RepoCache is what slows them.
// Failed calls are counted, not fatal, so a stage that overloads something still reports.
//
// Analytics count a class's requests across all its objects, so other work on the Worker would count too: the probe
// refuses to start while hosted agents, builders or a demo run were busy in the 10 minutes before, unless given
// `--anyway`. Access credentials come from .dev.vars, and analytics read through wrangler's login. Neither is
// printed. The repo is deleted at the end; analytics lag, so the report waits until the numbers settle.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_BASE, ROOT, githiveClient, parseFlags } from "./lib/bench-client.mjs";
import { durableObjectUse, namespacesOf } from "./lib/do-analytics.mjs";

const ACCOUNT = "0ee623ba24365823196215c72f6c0a78";

const flags = parseFlags();
const base = flags.base ?? BENCH_BASE;
const script = flags.script ?? (base === BENCH_BASE ? "blueprint-bench" : "blueprint");
const label = flags.label ?? "run";
const ladder = flags.ladder ? String(flags.ladder).split(",").map(Number) : [Number(flags.waiters ?? 50)];
const waiters = Math.max(...ladder);
const writers = Number(flags.writers ?? 5);
const runMs = Number(flags.minutes ?? 3) * 60_000;
const client = githiveClient(base);
const owner = flags.owner ?? "nuandy";
const name = `wait-probe-${Date.now().toString(36)}`;
const repo = `${owner}/${name}`;
const keys = {};
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${line}`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function call(tool, args, agent, stage) {
	const begun = Date.now();
	try {
		const { text, isError } = await client.toolReply(tool, { repo, ...args }, keys[agent]);
		if (isError) throw new Error(text.slice(0, 120));
		return JSON.parse(text);
	} catch (err) {
		const reason = `${tool}: ${String(err.message ?? err).slice(0, 80)}`;
		stage.failures[reason] = (stage.failures[reason] ?? 0) + 1;
		return null;
	} finally {
		(stage.took[tool] ??= []).push(Date.now() - begun);
	}
}

/** One waiting agent: `wait` with its last `seen` until the stage ends, noting when each wake came. */
async function waiter(agent, until, stage) {
	let seen;
	while (Date.now() < until) {
		const seconds = Math.max(1, Math.min(45, Math.floor((until - Date.now()) / 1000)));
		const reply = await call("wait", { agent, seconds, ...(seen ? { seen } : {}) }, agent, stage);
		if (!reply) {
			await wait(1_000);
			continue;
		}
		stage.waits++;
		if (reply.changed) {
			stage.woke++;
			stage.wakes.push(Date.now());
		}
		seen = reply.seen;
	}
}

/** One writer: claim, a vote from the next writer, release, round after round until the stage ends. */
async function writer(index, until, stage) {
	const agent = `writer-${index}`;
	const voter = `writer-${(index + 1) % writers}`;
	for (let round = 0; Date.now() < until; round++) {
		const change = `w${index}-${stage.waiters}-${round}`;
		await call(
			"claim",
			{ change, agent, paths: [`src/${change}/`], intent: `Round ${round} of ${agent}` },
			agent,
			stage,
		);
		const commit = (index * 1_000_000 + round).toString(16).padStart(40, "0");
		const evidence = "Read the change; it does what its intent says";
		await call("vote", { commit, change, reviewer: voter, role: "review", verdict: "approve", evidence }, voter, stage);
		const released = await call("release", { change, agent }, agent, stage);
		if (released) stage.releases.push(Date.now());
		stage.writes += 3;
	}
}

const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

/** p50, p95 and the most, in ms, of `durations`. */
function spread(durations) {
	if (!durations?.length) return null;
	const sorted = [...durations].sort((a, b) => a - b);
	return { calls: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), most: sorted.at(-1) };
}

// How long after a release each waiting agent heard of it: every release wakes them all, so each wake is timed from
// the last release before it.
function wakeDelays(releases, wakes) {
	const released = [...releases].sort((a, b) => a - b);
	let last = -1;
	return [...wakes]
		.sort((a, b) => a - b)
		.flatMap((at) => {
			while (last + 1 < released.length && released[last + 1] <= at) last++;
			return last < 0 ? [] : [at - released[last]];
		});
}

/** What the run's window cost, read again until two readings a minute apart agree, or 10 minutes pass. */
async function settledUse(namespaces, start, end) {
	let last;
	for (let tries = 0; tries < 10; tries++) {
		await wait(60_000);
		const use = await durableObjectUse(ACCOUNT, namespaces, start, end).catch((err) => {
			log(`analytics not read yet: ${String(err).slice(0, 160)}`);
			return undefined;
		});
		if (use && last && JSON.stringify(use) === JSON.stringify(last)) return use;
		last = use ?? last;
	}
	return last;
}

// Other work on the Worker would count as the probe's: what ran in the 10 minutes before says whether there is any.
async function refuseBusy() {
	const end = new Date();
	const before = await durableObjectUse(
		ACCOUNT,
		namespaces,
		new Date(end - 10 * 60_000).toISOString(),
		end.toISOString(),
	);
	const busy = ["HostedAgent", "Builder", "Reviewer", "DemoRun"].filter((kind) => (before[kind]?.requests ?? 0) > 20);
	if (!busy.length) return;
	const said = busy.map((kind) => `${kind} ${before[kind].requests}`).join(", ");
	console.error(
		`${script} was busy in the last 10 minutes (${said} requests): run again when it's quiet, or pass --anyway`,
	);
	process.exit(1);
}

function perWrite(use, writes) {
	return Object.fromEntries(
		Object.entries(use).map(([kind, each]) => [
			kind,
			{ requests: +(each.requests / writes).toFixed(2), activeMs: +(each.activeMs / writes).toFixed(1) },
		]),
	);
}

/** One stage: `count` agents waiting while every writer writes, for runMs. */
async function runStage(count) {
	const stage = { waiters: count, writes: 0, waits: 0, woke: 0, took: {}, failures: {}, releases: [], wakes: [] };
	const start = new Date().toISOString();
	const until = Date.now() + runMs;
	log(`stage: ${count} waiting, ${writers} writing`);
	await Promise.all([
		...Array.from({ length: count }, (_, i) => waiter(`waiter-${i}`, until, stage)),
		...Array.from({ length: writers }, (_, i) => writer(i, until, stage)),
	]);
	const window = { start, end: new Date().toISOString() };
	const took = Object.fromEntries(Object.entries(stage.took).map(([tool, durations]) => [tool, spread(durations)]));
	const failed = Object.values(stage.failures).reduce((total, n) => total + n, 0);
	log(`  ${stage.writes} writes, ${stage.waits} waits (${stage.woke} woke), ${failed} failed calls`);
	for (const tool of ["claim", "vote", "release"]) log(`  ${tool}: ${JSON.stringify(took[tool])}`);
	const wake = spread(wakeDelays(stage.releases, stage.wakes));
	log(`  wake after a release: ${JSON.stringify(wake)}`);
	return {
		...window,
		waiters: count,
		writes: stage.writes,
		waits: stage.waits,
		woke: stage.woke,
		took,
		wake,
		failures: stage.failures,
	};
}

// Registered a hundred at a time, each with its own key.
async function registerAll(agents) {
	for (let from = 0; from < agents.length; from += 100) {
		const batch = agents.slice(from, from + 100);
		const { text } = await client.toolReply("register", { repo, agents: batch });
		for (const each of JSON.parse(text).agents) keys[each.agent] = each.key;
	}
}

const namespaces = await namespacesOf(ACCOUNT, script);
if (flags.anyway === undefined) await refuseBusy();
await client.api("POST", "/repos", { owner, name, init: { readme: true } });
log(
	`repo ${repo}: stages of ${ladder.join(", ")} waiting, ${writers} writing, ${runMs / 60_000} min each, on ${script}`,
);
const stages = [];
try {
	await client.toolReply("settings", { repo, required: 1 });
	await registerAll([
		...Array.from({ length: waiters }, (_, i) => `waiter-${i}`),
		...Array.from({ length: writers }, (_, i) => `writer-${i}`),
	]);
	for (const count of ladder) stages.push(await runStage(count));
} finally {
	await client.api("DELETE", `/repos/${repo}`);
	log(`deleted ${repo}`);
}
log("reading analytics; they lag a few minutes");
for (const stage of stages) {
	stage.use = await settledUse(namespaces, stage.start, stage.end);
	stage.perWrite = stage.use && perWrite(stage.use, stage.writes);
	log(`${stage.waiters} waiting, per write: ${JSON.stringify(stage.perWrite?.RepoCache ?? null)} (RepoCache)`);
}
const result = { label, script, writers, minutes: runMs / 60_000, ladder, stages };
const folder = join(ROOT, "bench-results/notifications");
mkdirSync(folder, { recursive: true });
const file = join(folder, `${label}-${stages[0].start.slice(0, 16).replace(/[:T]/g, "")}.json`);
writeFileSync(file, `${JSON.stringify(result, null, "\t")}\n`);
log(`written to ${file.slice(ROOT.length)}`);
