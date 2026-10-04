#!/usr/bin/env node
// Load benchmark for open mode: fake agents drive the MCP front door at rising
// concurrency, the way real agents would, without calling a model. Each agent
// claims its own lane, pushes a commit, reports it, checks status and claims, and
// abandons. Alongside them, a few agents race for one shared path, and exactly
// one must win. After each level the Coordinator's lock timings are read, and at
// the end the Git notes record is replayed against the stored state.
//
//   node scripts/bench.mjs [--label baseline] [--levels 1,5,10,25] [--racers 5]
//                          [--base https://blueprint-bench.nuandy.workers.dev] [--repo bench-<label>]
//                          [--idle 40]   (changes held open through every level that never push)
//                          [--mode free] (coordinator-free mode: the same lifecycle through the free_* tools, no Coordinator)
//                          [--shard-depth 2] (free mode: how deep claims are sharded; 0 keeps them in one record)
//                          [--ramp 60]   (agents start spread evenly over this many seconds, instead of all at once)
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.
// Each run gets its own repo, so its Coordinator starts idle. Results go to
// bench-results/<label>-<time>.json after every level, with a summary table on stdout at the end.

import { execFile } from "node:child_process";
import fs from "node:fs";
import igit from "isomorphic-git";
import ihttp from "isomorphic-git/http/node";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const LABEL = args.label ?? "baseline";
const REPO = args.repo ?? `bench-${LABEL}`;
const SOURCE = args.source ?? "https://github.com/octocat/Spoon-Knife";
const LEVELS = (args.levels ?? "1,5,10,25").split(",").map(Number);
const RACERS = Number(args.racers ?? 5);
const IDLE = Number(args.idle ?? 0);
const FREE = args.mode === "free";
const SHARD_DEPTH = args["shard-depth"] === undefined ? undefined : Number(args["shard-depth"]);
const RAMP_MS = Number(args.ramp ?? 0) * 1000;

// Calls can wait minutes behind the lock under load; don't let the client give up first.
try {
	const { Agent, setGlobalDispatcher } = await import("undici");
	// Enough connections that the client doesn't queue calls agents would make at once.
	setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: Math.max(256, 4 * Math.max(...LEVELS)) }));
} catch {
	console.warn("undici not found: requests use Node's default 5-minute timeout");
}

const vars = Object.fromEntries(
	(await readFile(join(root, ".dev.vars"), "utf8"))
		.split("\n")
		.map((line) => line.match(/^([A-Z_]+)=(.*)$/))
		.filter(Boolean)
		.map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]),
);
const headers = {
	"CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID,
	"CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET,
	"Content-Type": "application/json",
};

/** For tasks run by the elected coordinator there is no Coordinator lock and no separate ledger: the log is the record. */
const optional = (promise, fallback) => promise.catch((err) => (/elected coordinator/.test(err.message) ? fallback : Promise.reject(err)));

async function api(method, path, body) {
	const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

/** Every timed MCP call, for the tables: {level, tool, ms, ok}. */
const calls = [];

/** Call an MCP tool, timing it (as `as`, to line up with open mode's tools). Tool errors throw with the tool's message. */
async function tool(level, name, args, as = name) {
	const start = performance.now();
	let ok = false;
	try {
		const reply = await api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
		if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
		const text = reply.result.content[0].text;
		if (reply.result.isError) throw Object.assign(new Error(`${name}: ${text}`), { toolError: true });
		ok = true;
		return JSON.parse(text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ""));
	} finally {
		if (as) calls.push({ level, tool: as, ms: performance.now() - start, ok });
	}
}

/** Time several calls as one step, under open mode's name for it. */
async function step(level, as, fn) {
	const start = performance.now();
	let ok = false;
	try {
		const result = await fn();
		ok = true;
		return result;
	} finally {
		calls.push({ level, tool: as, ms: performance.now() - start, ok });
	}
}

async function git(cwd, token, ...command) {
	await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...command], { cwd, maxBuffer: 16 << 20 });
}

/** One fake agent: claim a lane, push to it, report, look around, give it up. */
async function agent(level, taskId, runId, i, scratch) {
	const ids = { task_id: taskId };
	await tool(level, "list_claims", ids);
	const opened = await tool(level, "open_change", { ...ids, title: `bench ${runId} ${i}`, intent: "benchmark agent", paths: [`bench/${runId}/a${i}/`] });
	const change = { ...ids, change_id: opened.change_id };
	const token = opened.token.replace(/\?.*$/, "");
	const dir = join(scratch, `a${i}`);
	await git(scratch, token, "clone", "-q", "--depth", "1", opened.fork, dir);
	await mkdir(join(dir, "bench", runId, `a${i}`), { recursive: true });
	await writeFile(join(dir, "bench", runId, `a${i}`, "note.txt"), `agent ${i} of ${runId}\n`);
	await git(dir, token, "add", "-A");
	await git(dir, token, "-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-qm", `bench ${runId} ${i}`);
	await git(dir, token, "push", "-q", "origin", "HEAD:main");
	const pushed = await tool(level, "report_push", change);
	await tool(level, "change_status", change);
	await tool(level, "list_claims", ids);
	await tool(level, "abandon_change", { ...change, reason: "benchmark done" });
	return pushed;
}

/**
 * The same fake agent in coordinator-free mode, each step timed under open
 * mode's name for it: claim and get its change's fork (open_change), push,
 * Merge-ahead on itself (report_push), status, release (abandon_change).
 */
async function freeAgent(level, _taskId, runId, i, scratch) {
	const ids = { repo: REPO };
	const change_id = `${runId}-a${i}`;
	const agentName = `bench-${runId}-a${i}`;
	await tool(level, "free_claims", ids, "list_claims");
	const fork = await step(level, "open_change", async () => {
		// Each agent in its own directory, as agents splitting work would be: two segments deep, so its own claims shard.
		const claimed = await tool(level, "free_claim", { ...ids, change: change_id, agent: agentName, paths: [`bench-${runId}/a${i}/`], intent: "benchmark agent" }, null);
		if (!claimed.ok) throw new Error(`free_claim refused: ${JSON.stringify(claimed)}`);
		return tool(level, "free_credentials", { ...ids, change: change_id }, null);
	});
	const token = fork.token.replace(/\?.*$/, "");
	const dir = join(scratch, `a${i}`);
	// In-process git (isomorphic-git): a thousand agents' git processes would exceed this machine's process limit.
	const onAuth = () => ({ username: "x", password: token });
	await igit.clone({ fs, http: ihttp, dir, url: fork.url, depth: 1, singleBranch: true, onAuth });
	const file = `bench-${runId}/a${i}/note.txt`;
	await mkdir(join(dir, `bench-${runId}`, `a${i}`), { recursive: true });
	await writeFile(join(dir, file), `agent ${i} of ${runId}\n`);
	await igit.add({ fs, dir, filepath: file });
	await igit.commit({ fs, dir, message: `bench ${runId} ${i}`, author: { name: "bench", email: "bench@example.com" } });
	await igit.push({ fs, http: ihttp, dir, url: fork.url, ref: "main", remoteRef: `refs/heads/changes/${change_id}`, onAuth });
	const checked = await tool(level, "free_check", { ...ids, change: change_id }, "report_push");
	await tool(level, "free_status", { ...ids, change: change_id }, "change_status");
	await tool(level, "free_claims", ids, "list_claims");
	const released = await tool(level, "free_release", { ...ids, change: change_id, agent: agentName, reason: "benchmark done" }, "abandon_change");
	if (!released.ok) throw new Error(`free_release refused: ${JSON.stringify(released)}`);
	return checked;
}

/** Several agents claim the same path at once in coordinator-free mode: Git's compare-and-swap lets exactly one win. */
async function freeRace(level, _taskId, runId) {
	const results = await Promise.allSettled(
		Array.from({ length: RACERS }, (_, i) =>
			tool(level, "free_claim", { repo: REPO, change: `${runId}-r${i}`, agent: `bench-${runId}-r${i}`, paths: [`bench-${runId}/race/`], intent: "benchmark race" }, "open_change").then((r) => ({ ...r, i })),
		),
	);
	const won = results.filter((r) => r.status === "fulfilled" && r.value.ok).map((r) => r.value.i);
	const unexpected = results.filter((r) => r.status === "rejected" || (!r.value.ok && !r.value.conflicts?.length)).map((r) => (r.status === "rejected" ? r.reason.message : JSON.stringify(r.value)));
	// A failed release is recorded with the rest, not allowed to end the run.
	for (const i of won)
		await tool(level, "free_release", { repo: REPO, change: `${runId}-r${i}`, agent: `bench-${runId}-r${i}`, reason: "benchmark race done" }, "abandon_change").catch((err) => unexpected.push(`release: ${err.message}`));
	return { winners: won.length, unexpected };
}

/** Several agents claim the same path at once: exactly one may win. */
async function race(level, taskId, runId) {
	const results = await Promise.allSettled(
		Array.from({ length: RACERS }, (_, i) =>
			tool(level, "open_change", { task_id: taskId, title: `bench ${runId} racer ${i}`, intent: "benchmark race", paths: [`bench/${runId}/race/`] }),
		),
	);
	const winners = results.filter((r) => r.status === "fulfilled").map((r) => r.value.change_id);
	const unexpected = results.filter((r) => r.status === "rejected" && !/already claimed/.test(r.reason.message)).map((r) => r.reason.message);
	for (const change_id of winners) await tool(level, "abandon_change", { task_id: taskId, change_id, reason: "benchmark race done" });
	return { winners: winners.length, unexpected };
}

const pct = (values, p) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const summary = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: values.length ? Math.max(...values) : null });

/** The most calls holding or waiting for the lock at once, from the samples' intervals. */
function peakQueue(samples) {
	const events = samples.flatMap((s) => [
		[s.at, 1],
		[s.at + s.waitMs + s.runMs + s.flushMs, -1],
	]);
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let depth = 0;
	let peak = 0;
	for (const [, delta] of events) peak = Math.max(peak, (depth += delta));
	return peak;
}

async function main() {
	const repos = await api("GET", "/repos");
	const names = (Array.isArray(repos) ? repos : (repos.repos ?? [])).map((r) => (typeof r === "string" ? r : r.name));
	if (!names.includes(REPO)) {
		console.log(`importing ${SOURCE} as ${REPO}`);
		// The listing is one page, so the repo may exist without showing up.
		await api("POST", "/repos/import", { url: SOURCE, name: REPO, branch: "main" }).catch((err) => {
			if (!/exist/i.test(err.message)) throw err;
		});
	}
	if (FREE) {
		const started = await tool(0, "free_start", { repo: REPO, ...(SHARD_DEPTH === undefined ? {} : { shard_depth: SHARD_DEPTH }) });
		console.log(`coordinator-free mode on ${REPO} at ${BASE} (access: ${started.access}, claims sharded ${started.shardDepth ? `${started.shardDepth} deep, over ${started.recordsRepos || "no"} records repos` : "not at all"})`);
	}
	const task = FREE ? { id: null } : await api("POST", `/repos/${REPO}/open`, {});
	if (!FREE) console.log(`open task ${task.id} on ${REPO} at ${BASE}`);
	// Changes that claim a lane and never push, like agents still thinking, held through every level.
	const idle = [];
	for (let i = 0; i < (FREE ? 0 : IDLE); i += 10) {
		const batch = await Promise.all(
			Array.from({ length: Math.min(10, IDLE - i) }, (_, j) =>
				tool(0, "open_change", { task_id: task.id, title: `bench ${LABEL} idle ${i + j}`, intent: "idle benchmark change", paths: [`bench/idle-${LABEL}/i${i + j}/`] }),
			),
		);
		idle.push(...batch.map((o) => o.change_id));
	}
	if (IDLE) console.log(`${idle.length} idle changes open`);
	if (!FREE) await optional(api("POST", `/tasks/${task.id}/lock-stats/reset`), null);

	const levels = [];
	const result = { label: LABEL, mode: FREE ? "free" : "open", rampSeconds: RAMP_MS / 1000, base: BASE, repo: REPO, task: task.id, racers: RACERS, idle: IDLE, at: new Date().toISOString(), ledgerMatches: null, ledgerCommits: null, levels };
	await mkdir(join(root, "bench-results"), { recursive: true });
	const file = join(root, "bench-results", `${LABEL}-${result.at.replace(/[:.]/g, "-")}.json`);
	const save = () => writeFile(file, JSON.stringify(result, null, "\t") + "\n");
	for (const n of LEVELS) {
		const runId = `${LABEL}-n${n}-${Date.now().toString(36)}`;
		const scratch = await mkdtemp(join(tmpdir(), "blueprint-bench-"));
		const started = performance.now();
		const [agents, raced] = await Promise.all([
			Promise.allSettled(
				Array.from({ length: n }, async (_, i) => {
					// Arrivals spread over the ramp, like agents starting work, rather than all at one instant.
					if (RAMP_MS) await new Promise((resolve) => setTimeout(resolve, (RAMP_MS * i) / n));
					return (FREE ? freeAgent : agent)(n, task.id, runId, i, scratch);
				}),
			),
			(FREE ? freeRace : race)(n, task.id, runId),
		]);
		const wallMs = performance.now() - started;
		await rm(scratch, { recursive: true, force: true });

		const failures = agents.filter((a) => a.status === "rejected").map((a) => a.reason.message.slice(0, 200));
		const leftover = FREE
			? (await tool(n, "free_claims", { repo: REPO }, null)).filter((c) => c.change.startsWith(runId))
			: (await tool(n, "list_claims", { task_id: task.id })).filter((c) => c.title?.includes(runId));
		// Wait for the ledger to catch up (a no-op where it is written under the lock), so its lag is counted.
		// Coordinator-free mode has no lock and no ledger: the records in Git are all there is.
		const ledgerCheck = FREE ? { matches: null, commits: null } : await optional(api("GET", `/tasks/${task.id}/ledger`), { matches: null, commits: null });
		const { samples, ledgerLagMs = [] } = FREE ? { samples: [] } : await optional(api("POST", `/tasks/${task.id}/lock-stats/reset`), { samples: [], ledgerLagMs: [] });
		const levelCalls = calls.filter((c) => c.level === n);
		const tools = Object.fromEntries([...new Set(levelCalls.map((c) => c.tool))].map((name) => [name, summary(levelCalls.filter((c) => c.tool === name).map((c) => c.ms))]));
		const busy = samples.reduce((sum, s) => sum + s.runMs + s.flushMs, 0);
		const level = {
			agents: n,
			wallMs,
			calls: levelCalls.length,
			callsPerSecond: levelCalls.length / (wallMs / 1000),
			// Open mode's refused racers throw; coordinator-free refusals are answers ({ ok: false }).
			errors: levelCalls.filter((c) => !c.ok).length - (FREE ? 0 : RACERS - raced.winners),
			failures,
			race: raced,
			leftoverClaims: leftover.length,
			tools,
			lock: {
				samples: samples.length,
				waitMs: summary(samples.map((s) => s.waitMs)),
				runMs: summary(samples.map((s) => s.runMs)),
				flushMs: summary(samples.map((s) => s.flushMs)),
				busyFraction: busy / wallMs,
				flushShareOfHold: busy ? samples.reduce((sum, s) => sum + s.flushMs, 0) / busy : 0,
				peakQueue: peakQueue(samples),
				byCall: Object.fromEntries(
					[...new Set(samples.map((s) => s.label ?? "all"))].map((label) => {
						const mine = samples.filter((s) => (s.label ?? "all") === label);
						return [label, { n: mine.length, holdMs: summary(mine.map((s) => s.runMs + s.flushMs)), waitMs: summary(mine.map((s) => s.waitMs)) }];
					}),
				),
			},
			ledger: { matches: ledgerCheck.matches, commits: ledgerCheck.commits, lagMs: summary(ledgerLagMs) },
		};
		levels.push(level);
		await save();
		console.log(
			`n=${n}: ${(wallMs / 1000).toFixed(1)}s, ${level.calls} calls, lock wait p95 ${Math.round(level.lock.waitMs.p95 ?? 0)}ms, ` +
				`race winners ${raced.winners}, failures ${failures.length}, leftover claims ${leftover.length}, ` +
				(ledgerCheck.matches === null ? "ledger: the log is the record" : `ledger ${ledgerCheck.matches ? "matches" : "DOES NOT MATCH"} (lag p95 ${Math.round(level.ledger.lagMs.p95 ?? 0)}ms)`),
		);
	}

	for (const change_id of idle) await tool(0, "abandon_change", { task_id: task.id, change_id, reason: "benchmark done" });
	const ledger = FREE ? { matches: null, commits: null } : await optional(api("GET", `/tasks/${task.id}/ledger`), { matches: null, commits: null });
	result.ledgerMatches = ledger.matches;
	result.ledgerCommits = ledger.commits;
	await save();

	const ms = (v) => (v === null ? "-" : v >= 10_000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
	console.log(FREE ? `\n${LABEL}: coordinator-free (no lock, no ledger: the records in Git)\n` : ledger.matches === null ? `\n${LABEL}: elected coordinator (the log is the record)\n` : `\n${LABEL}: ledger replay ${ledger.matches ? "matches" : "DOES NOT MATCH"} (${ledger.commits} commits)\n`);
	console.log("| agents | wall | calls/s | list_claims p50/p95 | open_change p50/p95 | report_push p50/p95 | lock wait p50/p95 | lock hold p50 (ledger write) | peak queue | lock busy | ledger lag p95 | race winners | failures |");
	console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const l of levels) {
		const t = (name) => `${ms(l.tools[name]?.p50 ?? null)} / ${ms(l.tools[name]?.p95 ?? null)}`;
		console.log(
			`| ${l.agents} | ${ms(l.wallMs)} | ${l.callsPerSecond.toFixed(1)} | ${t("list_claims")} | ${t("open_change")} | ${t("report_push")} | ` +
				`${ms(l.lock.waitMs.p50)} / ${ms(l.lock.waitMs.p95)} | ${ms((l.lock.runMs.p50 ?? 0) + (l.lock.flushMs.p50 ?? 0))} (${ms(l.lock.flushMs.p50)}) | ` +
				`${l.lock.peakQueue} | ${Math.round(l.lock.busyFraction * 100)}% | ${ms(l.ledger?.lagMs.p95 ?? null)} | ${l.race.winners}/${RACERS} | ${l.failures.length} |`,
		);
	}
	console.log("\nlock hold by call (p50 / p95), at the largest level:");
	const last = levels.at(-1);
	for (const [label, v] of Object.entries(last?.lock.byCall ?? {})) console.log(`  ${label}: ${v.n} calls, hold ${ms(v.holdMs.p50)} / ${ms(v.holdMs.p95)}, wait ${ms(v.waitMs.p50)} / ${ms(v.waitMs.p95)}`);
	console.log(`\nfull results: ${file}`);
}

await main();
