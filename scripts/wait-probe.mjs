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
const waiters = Number(flags.waiters ?? 50);
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

async function call(tool, args, agent) {
	const { text, isError } = await client.toolReply(tool, { repo, ...args }, keys[agent]);
	if (isError) throw new Error(`${tool} as ${agent}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

/** One waiting agent: `wait` with its last `seen` until the run ends. Counts its calls and those that woke changed. */
async function waiter(agent, until, counts) {
	let seen;
	while (Date.now() < until) {
		const seconds = Math.max(1, Math.min(45, Math.floor((until - Date.now()) / 1000)));
		const reply = await call("wait", { agent, seconds, ...(seen ? { seen } : {}) }, agent);
		counts.waits++;
		if (reply.changed) counts.woke++;
		seen = reply.seen;
	}
}

/** One writer: claim, a vote from the next writer, release, round after round until the run ends. */
async function writer(index, until, counts) {
	const agent = `writer-${index}`;
	const voter = `writer-${(index + 1) % writers}`;
	for (let round = 0; Date.now() < until; round++) {
		const change = `w${index}-${round}`;
		await call("claim", { change, agent, paths: [`src/${change}/`], intent: `Round ${round} of ${agent}` }, agent);
		const commit = (index * 1_000_000 + round).toString(16).padStart(40, "0");
		const evidence = "Read the change; it does what its intent says";
		await call("vote", { commit, change, reviewer: voter, role: "review", verdict: "approve", evidence }, voter);
		await call("release", { change, agent }, agent);
		counts.writes += 3;
	}
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

const namespaces = await namespacesOf(ACCOUNT, script);
if (flags.anyway === undefined) await refuseBusy();
await client.api("POST", "/repos", { owner, name, init: { readme: true } });
log(`repo ${repo}: ${waiters} waiting, ${writers} writing, ${runMs / 60_000} min, on ${script}`);
const counts = { waits: 0, woke: 0, writes: 0 };
let window;
try {
	await call("settings", { required: 1 });
	const agents = [
		...Array.from({ length: waiters }, (_, i) => `waiter-${i}`),
		...Array.from({ length: writers }, (_, i) => `writer-${i}`),
	];
	for (let from = 0; from < agents.length; from += 20)
		await Promise.all(
			agents.slice(from, from + 20).map(async (agent) => {
				keys[agent] = JSON.parse((await client.toolReply("register", { repo, agent })).text).key;
			}),
		);
	const start = new Date().toISOString();
	const until = Date.now() + runMs;
	await Promise.all([
		...Array.from({ length: waiters }, (_, i) => waiter(`waiter-${i}`, until, counts)),
		...Array.from({ length: writers }, (_, i) => writer(i, until, counts)),
	]);
	window = { start, end: new Date().toISOString() };
	log(`done: ${counts.writes} writes, ${counts.waits} wait calls, ${counts.woke} of them woke changed`);
} finally {
	await client.api("DELETE", `/repos/${repo}`);
	log(`deleted ${repo}`);
}
log("reading analytics; they lag a few minutes");
const use = await settledUse(namespaces, window.start, window.end);
const result = {
	label,
	script,
	waiters,
	writers,
	minutes: runMs / 60_000,
	...window,
	counts,
	use,
	perWrite: use && perWrite(use, counts.writes),
};
const folder = join(ROOT, "bench-results/notifications");
mkdirSync(folder, { recursive: true });
const file = join(folder, `${label}-${window.start.slice(0, 16).replace(/[:T]/g, "")}.json`);
writeFileSync(file, `${JSON.stringify(result, null, "\t")}\n`);
log(`per write: ${JSON.stringify(result.perWrite)}`);
log(`written to ${file.slice(ROOT.length)}`);
