#!/usr/bin/env node
// Failover benchmark for the elected coordinator (milestone 6): agents keep
// opening and abandoning changes on an elected open task; partway through, the
// leader is crashed (it stops as if its object vanished, for longer than its
// lease). Measures how long decisions paused, how long calls took before and
// after, what failed, and who leads afterwards.
//
//   node scripts/failover.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--agents 10]
//                             [--duration 150] [--crash-at 40] [--crash-for 90] [--repo failover-<time>]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const AGENTS = Number(args.agents ?? 10);
const DURATION_MS = Number(args.duration ?? 150) * 1000;
const CRASH_AT_MS = Number(args["crash-at"] ?? 40) * 1000;
const CRASH_FOR_MS = Number(args["crash-for"] ?? 90) * 1000;
const REPO = args.repo ?? `failover-${Date.now().toString(36)}`;

try {
	const { Agent, setGlobalDispatcher } = await import("undici");
	setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 256 }));
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
const headers = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET, "Content-Type": "application/json" };

async function api(method, path, body) {
	const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

const t0 = performance.now();
const at = () => performance.now() - t0;
/** Every call: when it started and ended (ms since start), what it was, and how it went. */
const calls = [];

async function tool(agent, name, toolArgs) {
	const start = at();
	let ok = false;
	let error;
	try {
		const reply = await api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: toolArgs } });
		const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error);
		if (reply.error || reply.result.isError) throw new Error(`${name}: ${text}`);
		ok = true;
		return JSON.parse(text);
	} catch (err) {
		error = err.message.slice(0, 200);
		throw err;
	} finally {
		calls.push({ agent, tool: name, start, end: at(), ok, ...(error ? { error } : {}) });
	}
}

/** One agent: open a change on a path of its own, look at the claims, abandon it; again until the time is up. */
async function agent(i, taskId) {
	for (let k = 0; at() < DURATION_MS; k++) {
		try {
			const opened = await tool(i, "open_change", { task_id: taskId, title: `failover a${i} ${k}`, intent: "failover benchmark", paths: [`failover/a${i}/k${k}/`] });
			await tool(i, "list_claims", { task_id: taskId }).catch(() => {});
			await tool(i, "abandon_change", { task_id: taskId, change_id: opened.change_id, reason: "failover benchmark" });
		} catch {
			// Recorded; keep going, as an agent would.
		}
	}
}

const pct = (values, p) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const s = (ms) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);

console.log(`importing Spoon-Knife as ${REPO} on ${BASE}`);
await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: REPO, branch: "main" });
const task = await api("POST", `/repos/${REPO}/open`, {});
console.log(`open task ${task.id}; ${AGENTS} agents for ${DURATION_MS / 1000}s; crash the leader at ${CRASH_AT_MS / 1000}s for ${CRASH_FOR_MS / 1000}s`);

const crash = (async () => {
	await new Promise((resolve) => setTimeout(resolve, CRASH_AT_MS));
	const before = await api("GET", `/tasks/${task.id}/leader`);
	const crashedAt = at();
	const crashed = await api("POST", `/tasks/${task.id}/leader/crash`, { forMs: CRASH_FOR_MS });
	console.log(`${s(crashedAt)}: crashed ${crashed.crashed} (term ${crashed.term}; the task index named ${before.leader})`);
	return { crashedAt, crashed };
})();

await Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i, task.id)));
const { crashedAt, crashed } = await crash;
const after = await api("GET", `/tasks/${task.id}/leader`);

// Decisions (claims changed); reads aren't decisions.
const decisions = calls.filter((c) => c.tool !== "list_claims");
const okDecisions = decisions.filter((c) => c.ok).sort((a, b) => a.end - b.end);
const firstAfter = okDecisions.find((c) => c.start >= crashedAt);
const lastBefore = [...okDecisions].reverse().find((c) => c.end <= crashedAt);
const nextDone = okDecisions.find((c) => c.end > crashedAt);
const latencies = (from, to) => decisions.filter((c) => c.ok && c.start >= from && c.start < to).map((c) => c.end - c.start);
const errors = {};
for (const c of calls.filter((c) => !c.ok)) errors[c.error.replace(/[0-9a-f]{8,}/g, "…").slice(0, 120)] = (errors[c.error.replace(/[0-9a-f]{8,}/g, "…").slice(0, 120)] ?? 0) + 1;

const result = {
	base: BASE,
	repo: REPO,
	task: task.id,
	agents: AGENTS,
	durationS: DURATION_MS / 1000,
	crashAtS: crashedAt / 1000,
	crashForS: CRASH_FOR_MS / 1000,
	crashed: crashed.crashed,
	crashedTerm: crashed.term,
	leaderAfter: after,
	calls: calls.length,
	failed: calls.filter((c) => !c.ok).length,
	errors,
	/** From the crash to the first decision asked for after it that succeeded. */
	recoveryMs: firstAfter ? firstAfter.end - crashedAt : null,
	/** The longest time without any decision completing, around the crash. */
	gapMs: lastBefore && nextDone ? nextDone.end - lastBefore.end : null,
	before: { decisions: latencies(0, crashedAt).length, p50Ms: pct(latencies(0, crashedAt), 50), p95Ms: pct(latencies(0, crashedAt), 95) },
	after: firstAfter
		? { decisions: latencies(firstAfter.end, Infinity).length, p50Ms: pct(latencies(firstAfter.end, Infinity), 50), p95Ms: pct(latencies(firstAfter.end, Infinity), 95) }
		: null,
	slowestDuringMs: Math.max(0, ...decisions.filter((c) => c.start < (firstAfter?.end ?? Infinity) && c.end > crashedAt).map((c) => c.end - c.start)),
};
await mkdir(join(root, "bench-results"), { recursive: true });
const file = join(root, "bench-results", `failover-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(file, JSON.stringify(result, null, "\t") + "\n");

console.log(`\nleader: ${crashed.crashed} (term ${crashed.term}) crashed at ${s(crashedAt)}; afterwards ${after.leader ?? "nobody"} leads (term ${after.term})`);
console.log(`recovery: the first decision asked for after the crash finished ${s(result.recoveryMs)} after it; the longest gap between decisions was ${s(result.gapMs)}`);
console.log(`decisions before: ${result.before.decisions}, p50 ${s(result.before.p50Ms)}, p95 ${s(result.before.p95Ms)}`);
if (result.after) console.log(`decisions after:  ${result.after.decisions}, p50 ${s(result.after.p50Ms)}, p95 ${s(result.after.p95Ms)}`);
console.log(`slowest decision spanning the outage: ${s(result.slowestDuringMs)}; ${result.failed} of ${result.calls} calls failed`);
for (const [message, count] of Object.entries(errors)) console.log(`  ${count} × ${message}`);
console.log(`\nfull results: ${file}`);
