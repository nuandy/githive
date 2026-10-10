#!/usr/bin/env node
// Load benchmark: fake agents drive the MCP endpoint at rising concurrency
// without calling a model. Each agent claims its own directory, pushes a commit,
// checks it, reads its status and the claims, and releases. A few racers claim
// one shared path at the same time, and exactly one must win.
//
//   node scripts/bench.mjs [--label baseline] [--levels 1,5,10,25] [--racers 5]
//                          [--base https://blueprint-bench.nuandy.workers.dev] [--repo bench-<label>]
//                          [--shard-depth 2] (how deep claims are sharded; 0 keeps them in one record)
//                          [--records-repos N] (how many records repos the shards are spread over;
//                                               default the toolkit's)
//                          [--ramp 60]   (agents start spread evenly over this many seconds, instead of all at once)
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.
// Results go to bench-results/<label>-<time>.json after every level, with a summary table on stdout at the end.

import fs from "node:fs";
import igit from "isomorphic-git";
import ihttp from "isomorphic-git/http/node";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const LABEL = args.label ?? "baseline";
const REPO = args.repo ?? `bench-${LABEL}`;
const SOURCE = args.source ?? "https://github.com/octocat/Spoon-Knife";
const LEVELS = (args.levels ?? "1,5,10,25").split(",").map(Number);
const RACERS = Number(args.racers ?? 5);
const SHARD_DEPTH = args["shard-depth"] === undefined ? undefined : Number(args["shard-depth"]);
const RECORDS_REPOS = args["records-repos"] === undefined ? undefined : Number(args["records-repos"]);
const RAMP_MS = Number(args.ramp ?? 0) * 1000;

// Calls can wait under load; don't let the client give up first.
try {
	const { Agent, setGlobalDispatcher } = await import("undici");
	// Enough connections that the client doesn't queue calls agents would make at once.
	setGlobalDispatcher(
		new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: Math.max(256, 4 * Math.max(...LEVELS)) }),
	);
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

async function api(method, path, body) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

/** Every timed MCP call: {level, tool, ms, ok}. */
const calls = [];

/** Calls an MCP tool, timed under `as` unless it is null. Tool errors throw with the tool's message. */
async function tool(level, name, args, as = name) {
	const start = performance.now();
	let ok = false;
	try {
		const reply = await api("POST", "/mcp", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		});
		if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
		const text = reply.result.content[0].text;
		if (reply.result.isError) throw Object.assign(new Error(`${name}: ${text}`), { toolError: true });
		ok = true;
		return JSON.parse(text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ""));
	} finally {
		if (as) calls.push({ level, tool: as, ms: performance.now() - start, ok });
	}
}

/** Times several calls as one named step. */
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

/** One fake agent's full cycle, from claim to release. */
async function agent(level, runId, i, scratch) {
	const ids = { repo: REPO };
	const change_id = `${runId}-a${i}`;
	const agentName = `bench-${runId}-a${i}`;
	await tool(level, "claims", ids);
	const fork = await step(level, "claim", async () => {
		// A directory two segments deep, so each agent's claims shard.
		const claimed = await tool(
			level,
			"claim",
			{ ...ids, change: change_id, agent: agentName, paths: [`bench-${runId}/a${i}/`], intent: "benchmark agent" },
			null,
		);
		if (!claimed.ok) throw new Error(`claim refused: ${JSON.stringify(claimed)}`);
		return tool(level, "credentials", { ...ids, change: change_id }, null);
	});
	const token = fork.token.replace(/\?.*$/, "");
	const dir = join(scratch, `a${i}`);
	// In-process git (isomorphic-git), since a git process per agent can exceed the machine's process limit.
	const onAuth = () => ({ username: "x", password: token });
	await igit.clone({ fs, http: ihttp, dir, url: fork.url, depth: 1, singleBranch: true, onAuth });
	const file = `bench-${runId}/a${i}/note.txt`;
	await mkdir(join(dir, `bench-${runId}`, `a${i}`), { recursive: true });
	await writeFile(join(dir, file), `agent ${i} of ${runId}\n`);
	await igit.add({ fs, dir, filepath: file });
	await igit.commit({ fs, dir, message: `bench ${runId} ${i}`, author: { name: "bench", email: "bench@example.com" } });
	await igit.push({
		fs,
		http: ihttp,
		dir,
		url: fork.url,
		ref: "main",
		remoteRef: `refs/heads/changes/${change_id}`,
		onAuth,
	});
	// status test-merges the change too (its merge section), as check did before it was folded in.
	const checked = await tool(level, "status", { ...ids, change: change_id });
	await tool(level, "claims", ids);
	const released = await tool(level, "release", {
		...ids,
		change: change_id,
		agent: agentName,
		reason: "benchmark done",
	});
	if (!released.ok) throw new Error(`release refused: ${JSON.stringify(released)}`);
	return checked;
}

/** Several agents claim the same path at once, and exactly one may win. */
async function race(level, runId) {
	const results = await Promise.allSettled(
		Array.from({ length: RACERS }, (_, i) =>
			tool(
				level,
				"claim",
				{
					repo: REPO,
					change: `${runId}-r${i}`,
					agent: `bench-${runId}-r${i}`,
					paths: [`bench-${runId}/race/`],
					intent: "benchmark race",
				},
				"race",
			).then((r) => ({ ...r, i })),
		),
	);
	const won = results.filter((r) => r.status === "fulfilled" && r.value.ok).map((r) => r.value.i);
	const unexpected = results
		.filter((r) => r.status === "rejected" || (!r.value.ok && !r.value.conflicts?.length))
		.map((r) => (r.status === "rejected" ? r.reason.message : JSON.stringify(r.value)));
	// Record a failed release rather than ending the run.
	for (const i of won)
		await tool(
			level,
			"release",
			{ repo: REPO, change: `${runId}-r${i}`, agent: `bench-${runId}-r${i}`, reason: "benchmark race done" },
			null,
		).catch((err) => unexpected.push(`release: ${err.message}`));
	return { winners: won.length, unexpected };
}

const pct = (values, p) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const summary = (values) => ({
	n: values.length,
	p50: pct(values, 50),
	p95: pct(values, 95),
	p99: pct(values, 99),
	max: values.length ? Math.max(...values) : null,
});

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
	// The first settings call starts GitHive on the repo. On a started repo, existing claims are kept.
	const started = await tool(0, "settings", {
		repo: REPO,
		...(SHARD_DEPTH === undefined ? {} : { shard_depth: SHARD_DEPTH }),
		...(RECORDS_REPOS === undefined ? {} : { records_repos: RECORDS_REPOS }),
	}).catch((err) => {
		if (!/has started on|set when GitHive starts/.test(err.message)) throw err;
		return null;
	});
	if (!started) console.log(`${REPO} at ${BASE} (GitHive had started on it: its claims are kept as they were)`);
	else if (!started.shardDepth) console.log(`${REPO} at ${BASE} (claims sharded not at all)`);
	else {
		const repos = started.recordsRepos || "no";
		console.log(`${REPO} at ${BASE} (claims sharded ${started.shardDepth} deep, over ${repos} records repos)`);
	}

	const levels = [];
	const result = {
		label: LABEL,
		rampSeconds: RAMP_MS / 1000,
		base: BASE,
		repo: REPO,
		racers: RACERS,
		at: new Date().toISOString(),
		levels,
	};
	await mkdir(join(root, "bench-results"), { recursive: true });
	const file = join(root, "bench-results", `${LABEL}-${result.at.replace(/[:.]/g, "-")}.json`);
	const save = () => writeFile(file, JSON.stringify(result, null, "\t") + "\n");
	for (const n of LEVELS) {
		const runId = `${LABEL}-n${n}-${Date.now().toString(36)}`;
		const scratch = await mkdtemp(join(tmpdir(), "githive-bench-"));
		const startedAt = performance.now();
		const [agents, raced] = await Promise.all([
			Promise.allSettled(
				Array.from({ length: n }, async (_, i) => {
					// Spread arrivals over the ramp instead of starting all at once.
					if (RAMP_MS) await new Promise((resolve) => setTimeout(resolve, (RAMP_MS * i) / n));
					return agent(n, runId, i, scratch);
				}),
			),
			race(n, runId),
		]);
		const wallMs = performance.now() - startedAt;
		await rm(scratch, { recursive: true, force: true });

		const failures = agents.filter((a) => a.status === "rejected").map((a) => a.reason.message.slice(0, 200));
		const leftover = (await tool(n, "claims", { repo: REPO }, null)).filter((c) => c.change.startsWith(runId));
		const levelCalls = calls.filter((c) => c.level === n);
		const tools = Object.fromEntries(
			[...new Set(levelCalls.map((c) => c.tool))].map((name) => [
				name,
				summary(levelCalls.filter((c) => c.tool === name).map((c) => c.ms)),
			]),
		);
		const level = {
			agents: n,
			wallMs,
			calls: levelCalls.length,
			callsPerSecond: levelCalls.length / (wallMs / 1000),
			// Refused racers are answers ({ ok: false }), not errors.
			errors: levelCalls.filter((c) => !c.ok).length,
			failures,
			race: raced,
			leftoverClaims: leftover.length,
			tools,
		};
		levels.push(level);
		await save();
		console.log(
			`n=${n}: ${(wallMs / 1000).toFixed(1)}s, ${level.calls} calls, race winners ${raced.winners}, ` +
				`failures ${failures.length}, leftover claims ${leftover.length}`,
		);
	}

	const ms = (v) => {
		if (v === null) return "-";
		if (v >= 10_000) return `${(v / 1000).toFixed(0)}s`;
		if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
		return `${Math.round(v)}ms`;
	};
	console.log(`\n${LABEL}\n`);
	console.log(
		"| agents | wall | calls/s | claims p50/p95 | claim p50/p95 | status p50/p95 | release p50/p95 | " +
			"race winners | failures |",
	);
	console.log("|---|---|---|---|---|---|---|---|---|");
	for (const l of levels) {
		const t = (name) => `${ms(l.tools[name]?.p50 ?? null)} / ${ms(l.tools[name]?.p95 ?? null)}`;
		console.log(
			`| ${l.agents} | ${ms(l.wallMs)} | ${l.callsPerSecond.toFixed(1)} | ${t("claims")} | ${t("claim")} ` +
				`| ${t("status")} | ${t("release")} | ${l.race.winners}/${RACERS} | ${l.failures.length} |`,
		);
	}
	console.log(`\nfull results: ${file}`);
}

await main();
