#!/usr/bin/env node
// Run scripted outside agents on a repo, all at once, the way
// users would: they send agents, not a team of builders and reviewers. Every
// agent is the same: it asks next what to do, does it, and asks again.
// Building a piece of the backlog, it claims, clones the project, takes its
// time over the piece's scripted edit, pushes to its fork and checks; it
// recovers as an agent would (extends its claim when a file falls outside
// it, merges the project's branch in on a conflict). Reviewing, it gets the
// change through GitHive (review_access), takes its time, runs the
// tests and votes by their exit code, in the role next names. Asked to
// revise, it applies the piece's fix, or asks a person. Asked to merge, it
// merges. Nothing waits on anything but the protocol. Prints each step as it
// happens, then a timeline per piece of work, what each agent did, and the
// audit.
//
//   node scripts/swarm.mjs <plan.json> [--base URL] [--speed N] [--setup-only]
//
// The plan (paths in it are relative to the plan's own directory):
//   {
//     "repo": "express",
//     "work": "swarm-work",                  where clones go (emptied first)
//     "test": "npm test",                    what reviewers run on each commit (optional)
//     "nodeModules": "upstream/node_modules", linked into each reviewer's checkout (optional)
//     "seed": 7,                             for the random timings, so a run can be repeated
//     "timing": { "arrive": [0, 120], "edit": [30, 180], "fix": [30, 120], "review": [20, 90] },
//                                           seconds, each a [min, max] range (--speed N divides them)
//     "agents": [{ "agent": "agent-1", "keyFile": "keys/agent-1.key" }],   all alike
//     "planner": { "agent": "planner", "keyFile": "keys/planner.key" },    adds the backlog
//     "backlog": [{ "id": "const-lib", "title": "...", "intent": "...", "paths": ["lib/"],
//                   "edit": "node $PLAN/edits/const-requires.mjs . lib", "message": "commit message",
//                   "fix": "node $PLAN/edits/fix.mjs .",   what its builder does about a rejection (optional)
//                   "onReject": "fix" | "ask" | "stop",     default: fix if it has one, else stop
//                   "rejectFirst": "what to change" }],     the first review of it asks for changes (optional)
//     "setup": { "import": "https://github.com/expressjs/express", "branch": "master",
//                "template": "express-template",   imported once; each run's repo is a copy of it (seconds, not a minute)
//                "verify": ["npm install", "npm test"], "required": 1,
//                "grants": { "security": ["agent-3"] },
//                "shardDepth": 2 }                  optional: shard the claims from the start; make the repo first
//   }
//
// Agents whose keyFile doesn't exist yet are registered first (register),
// the key written to that file: each needs its own identity, or their votes
// count as one and an author's reviewers as the author. A piece's edit and fix
// run in its builder's clone, with $PLAN set to the plan's directory. --base
// defaults to the bench Worker. Access credentials come from .dev.vars.
// Tokens and keys are never printed.

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Agent, fetch } from "undici";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const planPath = resolve(args[0] ?? "");
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const BASE = flag("base") ?? "https://blueprint-bench.nuandy.workers.dev";
const speed = Number(flag("speed") ?? 1);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const here = dirname(planPath);
const at = (path) => (path && !isAbsolute(path) ? join(here, path) : path);
const vars = Object.fromEntries(readFileSync(join(root, ".dev.vars"), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));
const access = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET };
// A merge can wait for its batch for minutes: no client-side timeouts.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
/** The whole run gives up after this long. */
const RUN_LIMIT_MS = 60 * 60_000;

const started = Date.now();
const clock = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const say = (who, text) => console.log(`${clock()}  ${who.padEnd(12)} ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeded timings (mulberry32): the same plan and seed wait about the same way.
let seed = plan.seed ?? 1;
const random = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const timing = { arrive: [0, 120], edit: [30, 180], fix: [30, 120], review: [20, 90], ...plan.timing };
/** Milliseconds to spend on `step`, divided by --speed. */
const draw = (step) => {
	const [min, max] = timing[step];
	return ((min + random() * (max - min)) * 1000) / speed;
};

/** How often a call whose connection dropped is tried, in all. */
const CALL_TRIES = 4;

async function tool(name, toolArgs, keyFile) {
	const key = keyFile ? readFileSync(at(keyFile), "utf8").trim() : undefined;
	const request = () =>
		fetch(`${BASE}/mcp`, {
			method: "POST",
			dispatcher: patient,
			headers: { ...access, "Content-Type": "application/json", ...(key ? { "X-GitHive-Agent-Key": key } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: plan.repo, ...toolArgs } } }),
		});
	// A dropped connection (a reset, say) is tried again: one killed a 200-agent run while it filed its backlog. Only the
	// network's failures (fetch throws a TypeError), never GitHive's answers; the calls a run makes are safe to repeat.
	let response;
	for (let attempt = 1; ; attempt++) {
		try {
			response = await request();
			break;
		} catch (err) {
			if (!(err instanceof TypeError) || attempt === CALL_TRIES) throw err;
			await sleep(1_000 * attempt);
		}
	}
	if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	const reply = await response.json();
	if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
	const text = reply.result.content[0].text;
	if (reply.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

const sh = (cwd, command) => run("bash", ["-lc", command], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PLAN: here } });
const git = (cwd, ...rest) => run("git", ["-C", cwd, ...rest], { maxBuffer: 64 * 1024 * 1024 });
const helper = (...rest) => run("node", [join(root, "scripts/mcp-agent.mjs"), ...rest, "--base", BASE], { maxBuffer: 16 * 1024 * 1024 });

const work = at(plan.work ?? "swarm-work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
let branch = plan.setup?.branch ?? "main";

const pieces = new Map(plan.backlog.map((p) => [p.id, p]));
/** Each piece's timeline: when each step happened, who did what, what it ran into. */
const timeline = new Map(plan.backlog.map((p) => [p.id, { heads: [], reviews: [], events: [] }]));
const mark = (id, step) => (timeline.get(id)[step] ??= Date.now() - started);
const note = (id, event) => timeline.get(id).events.push(event);
/** What each agent did. */
const did = new Map(plan.agents.map((a) => [a.agent, { build: 0, review: 0, revise: 0, merge: 0, wait: 0 }]));
/** Pieces whose first review has asked for changes already (rejectFirst happens once). */
const askedOnce = new Set();
/** Pieces settled for this run: merged, waiting on a person, or stopped. */
const settled = new Map();
const settlePiece = (id, outcome) => {
	settled.set(id, outcome);
	lastSettled = Date.now();
};
const allSettled = () => plan.backlog.every((p) => settled.has(p.id));
/**
 * Pieces that landed in another merge's batch: a merge lands every approved
 * change into the branch, so a piece's own agent may never be told to merge
 * it. Read from what the repo's landing says changes came to, every few
 * seconds at most.
 */
let landingsReadAt = 0;
async function settleLanded() {
	if (Date.now() - landingsReadAt < 5_000) return;
	landingsReadAt = Date.now();
	const landing = await fetch(`${BASE}/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(branch)}`, { headers: access, dispatcher: patient })
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null);
	for (const s of landing?.recent ?? []) {
		if (s.how !== "landed" || settled.has(s.change) || !timeline.has(s.change)) continue;
		const t = timeline.get(s.change);
		t.merged ??= Date.parse(s.at) - started;
		t.commit = s.commit;
		settlePiece(s.change, `merged ${s.commit.slice(0, 8)}`);
		say("swarm", `${s.change} landed as ${s.commit.slice(0, 8)}, in another merge's batch`);
	}
}

/** One agent's hands: build, review, revise and merge, as next says. */
function agentFor(spec) {
	const { agent: name, keyFile: key } = spec;
	const call = (toolName, toolArgs) => tool(toolName, toolArgs, key);
	const dirOf = (id) => join(work, id);
	const claimed = new Map();

	const commitAndPush = async (id, message) => {
		const dir = dirOf(id);
		await git(dir, "add", "-A");
		await git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@agents.example`, "commit", "-q", "-m", message);
		await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${id}`);
		const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
		const { stdout: stat } = await git(dir, "show", "--stat", "--format=", "HEAD");
		timeline.get(id).heads.push(head);
		say(name, `pushed ${id} ${head.slice(0, 7)}: ${stat.trim().split("\n").at(-1).trim()}`);
	};
	/** The project's branch merged in (deep enough to find where they meet), and pushed. */
	const mergeProject = async (id) => {
		const dir = dirOf(id);
		await git(dir, "fetch", "-q", "--depth", "50", "origin", branch);
		await git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@agents.example`, "merge", "-q", "--no-edit", `origin/${branch}`).catch(async (err) => {
			await git(dir, "merge", "--abort").catch(() => undefined);
			throw new Error(`conflicts with ${branch} it can't resolve inside its claim: ${String(err.stderr ?? err).slice(0, 160)}`);
		});
		note(id, `merged ${branch} in`);
		await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${id}`);
		timeline.get(id).heads.push((await git(dir, "rev-parse", "HEAD")).stdout.trim());
		say(name, `merged ${branch} into ${id} and pushed`);
	};
	const extendClaim = async (id, files, when) => {
		const paths = [...new Set([...(claimed.get(id) ?? []), ...files])];
		const piece = pieces.get(id);
		const result = await call("claim", { change: id, agent: name, paths, intent: piece.intent });
		if (!result.ok) throw new Error(`couldn't extend its claim to ${files.join(", ")}: ${JSON.stringify(result.conflicts ?? result).slice(0, 160)}`);
		claimed.set(id, paths);
		note(id, `extended claim ${when} (${files.length})`);
		say(name, `extends ${id}'s claim to ${files.join(", ")}`);
	};
	/** Check after a push: extend the claim to files outside it, merge the project in on a conflict. */
	const settle = async (id) => {
		for (let round = 0; round < 3; round++) {
			const checked = await call("check", { change: id });
			mark(id, "checked");
			if (checked.outsideClaim?.length) {
				await extendClaim(id, checked.outsideClaim, "at check");
				continue;
			}
			if (checked.main && !checked.main.clean) {
				await mergeProject(id);
				continue;
			}
			return;
		}
	};

	const build = async (item) => {
		const piece = pieces.get(item.id);
		if (!piece) throw new Error(`next offered ${item.id}, which isn't in this plan's backlog`);
		const paths = piece.paths ?? item.paths ?? [];
		const result = await call("claim", { change: piece.id, agent: name, paths, intent: piece.intent }).catch((err) => ({ ok: false, error: String(err.message ?? err) }));
		if (!result.ok) {
			// Told the same piece as another agent, which claimed it first: ask again.
			say(name, `couldn't claim ${piece.id}: ${(result.error ?? JSON.stringify(result.conflicts)).slice(0, 100)}`);
			return;
		}
		claimed.set(piece.id, paths);
		timeline.get(piece.id).builder = name;
		mark(piece.id, "claimed");
		say(name, `builds ${piece.id} (${paths.length} path(s))`);
		const dir = dirOf(piece.id);
		// Starting over after a build that failed partway (next says finish): a fresh clone.
		rmSync(dir, { recursive: true, force: true });
		await helper("clone", dir, "--repo", plan.repo, "--change", piece.id, ...(key ? ["--key-file", at(key)] : []));
		await git(dir, "checkout", "-q", "-b", `changes/${piece.id}`);
		await sleep(draw("edit"));
		await sh(dir, piece.edit);
		await commitAndPush(piece.id, piece.message ?? piece.intent);
		mark(piece.id, "pushed");
		await settle(piece.id);
	};

	const review = async (next) => {
		const dir = join(work, `review-${name}-${next.change}`);
		rmSync(dir, { recursive: true, force: true });
		try {
			const { stdout } = await helper("review-clone", dir, "--repo", plan.repo, "--change", next.change, ...(key ? ["--key-file", at(key)] : []));
			const got = JSON.parse(stdout.trim().split("\n").at(-1));
			if (got.head !== next.head) return; // pushed again meanwhile: ask again
			const { stdout: stat } = await git(dir, "diff", "--stat", `${got.base}...HEAD`);
			await sleep(draw("review"));
			let verdict = "approve";
			let evidence = `Read the diff (${stat.trim().split("\n").at(-1)?.trim() ?? "no changes"}).`;
			if (plan.test) {
				if (plan.nodeModules && !existsSync(join(dir, "node_modules"))) symlinkSync(at(plan.nodeModules), join(dir, "node_modules"));
				// The test command's exit code decides; its summary lines are the evidence.
				const { stdout: out } = await sh(dir, `${plan.test} > .swarm-test.log 2>&1; echo "exit=$?"; tail -60 .swarm-test.log`);
				const failing = !/^exit=0$/m.test(out);
				const summary = (out.match(/\d+ passing|\d+ failing|\d+ pending|Tests\s+[^\n]*/g) ?? []).join(", ");
				if (failing) verdict = "reject";
				evidence += ` ${plan.test}: ${summary || (failing ? "failed" : "passed")}${failing ? ` (exit ${out.match(/^exit=(\d+)$/m)?.[1]})` : ""}.`;
			}
			// A scripted request for changes: the first review of the piece asks for it.
			const ask = pieces.get(next.change)?.rejectFirst;
			if (ask && verdict === "approve" && !askedOnce.has(next.change)) {
				askedOnce.add(next.change);
				verdict = "reject";
				evidence = `${ask} ${evidence}`;
			}
			await call("vote", { commit: next.head, reviewer: name, role: next.role, verdict, evidence });
			timeline.get(next.change)?.reviews.push(`${name}${next.role !== "review" ? ` as ${next.role}` : ""}: ${verdict}`);
			say(name, `${verdict === "approve" ? "approves" : "rejects"} ${next.change} (${next.head.slice(0, 7)})${next.role !== "review" ? ` as ${next.role}` : ""}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	const revise = async (next) => {
		const piece = pieces.get(next.change);
		const onReject = piece?.onReject ?? (piece?.fix ? "fix" : "stop");
		note(next.change, `rejected by ${next.reviewer}`);
		say(name, `${next.reviewer} asks for changes to ${next.change}: ${next.evidence.slice(0, 100)}`);
		if (onReject === "fix" && piece?.fix && !timeline.get(next.change).revised) {
			await sleep(draw("fix"));
			await sh(dirOf(next.change), piece.fix);
			await commitAndPush(next.change, `Address review: ${next.evidence.slice(0, 60)}`);
			mark(next.change, "revised");
			await settle(next.change);
			return;
		}
		if (onReject === "ask") {
			await call("ask_human", { change: next.change, agent: name, reason: `A reviewer asked for changes I shouldn't decide alone: ${next.evidence}` });
			note(next.change, "asked a person");
			settlePiece(next.change, "waits on a person");
			say(name, `asks a person about ${next.change}`);
			return;
		}
		settlePiece(next.change, `stopped: changes requested (${next.evidence.slice(0, 60)})`);
		await call("release", { change: next.change, agent: name, reason: "a reviewer asked for changes I can't make" });
	};

	const merge = async (next) => {
		mark(next.change, "approved");
		const merged = await call("merge", { change: next.change, agent: name });
		if (merged.ok) {
			mark(next.change, "merged");
			timeline.get(next.change).commit = merged.commit;
			settlePiece(next.change, `merged ${merged.commit.slice(0, 8)}`);
			say(name, `merged ${next.change} as ${merged.commit.slice(0, 8)}`);
			return;
		}
		const reasons = (merged.reasons ?? []).join("; ");
		const outside = [...reasons.matchAll(/(\S+) is outside /g)].map((m) => m[1]);
		if (outside.length) return extendClaim(next.change, outside, "at merge");
		if (merged.conflicts?.length) {
			await mergeProject(next.change);
			return settle(next.change);
		}
		say(name, `merge of ${next.change} refused: ${reasons.slice(0, 160)}`);
		note(next.change, `merge refused: ${reasons.slice(0, 60)}`);
	};

	return async () => {
		await sleep(draw("arrive"));
		say(name, "arrives");
		const until = started + RUN_LIMIT_MS;
		while (Date.now() < until) {
			let next;
			try {
				next = await call("next", { agent: name });
				if (next.kind === "wait") {
					did.get(name).wait++;
					await settleLanded();
					if (allSettled()) break;
					// Asked again soon: a merge or a review can free work any moment.
					await sleep(Math.min(next.retryAfterSeconds ?? 30, 5) * 1000);
					continue;
				}
				did.get(name)[next.kind === "finish" ? "build" : next.kind]++;
				if (next.kind === "build") await build(next.work);
				else if (next.kind === "finish") await build({ id: next.change });
				else if (next.kind === "review") await review(next);
				else if (next.kind === "revise") await revise(next);
				else if (next.kind === "merge") await merge(next);
			} catch (err) {
				const id = next?.change ?? next?.work?.id;
				// A command's own message is mostly its command line: what it printed last says why it failed.
				const why = err.stderr ? String(err.stderr).trim().split("\n").slice(-2).join(" | ") : String(err.message ?? err);
				say(name, `${next?.kind ?? "next"}${id ? ` ${id}` : ""} failed: ${why.slice(0, 300)}`);
				if (id && timeline.has(id)) note(id, `${next.kind} failed`);
				await sleep(10_000);
			}
		}
		say(name, "done");
	};
}

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", dispatcher: patient, headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify(body) });
if (plan.setup) {
	const repos = new Set((await (await fetch(`${BASE}/repos`, { headers: access, dispatcher: patient })).json()).map((r) => r.name.replace(/^_\//, "")));
	if (!repos.has(plan.repo)) {
		const template = plan.setup.template;
		if (template && !repos.has(template)) {
			say("swarm", `importing ${plan.setup.import} as ${template}, once`);
			const imported = await post("/repos/import", { url: plan.setup.import, name: template, branch: plan.setup.branch });
			if (!imported.ok) throw new Error(`import failed: HTTP ${imported.status}`);
		}
		say("swarm", template ? `copying ${template} as ${plan.repo}` : `importing ${plan.setup.import} as ${plan.repo}`);
		const made = template ? await post(`/repos/_/${template}/copy`, { name: plan.repo }) : await post("/repos/import", { url: plan.setup.import, name: plan.repo, branch: plan.setup.branch });
		if (!made.ok) throw new Error(`making ${plan.repo} failed: HTTP ${made.status} ${(await made.text()).slice(0, 200)}`);
	}
	const startedMode = await tool("start", { required: plan.setup.required ?? 1, ...(plan.setup.verify ? { verify: plan.setup.verify } : {}), ...(plan.setup.grants ? { grants: plan.setup.grants } : {}), ...(plan.setup.shardDepth !== undefined ? { shard_depth: plan.setup.shardDepth } : {}) });
	branch = startedMode.branch;
	say("swarm", `${plan.repo} on ${branch}: checks ${JSON.stringify(startedMode.verify)}, grants ${JSON.stringify(startedMode.policy?.grants ?? {})}, claims ${JSON.stringify(startedMode.sharding)}`);
}
/**
 * Run `fn` over `items`, `n` at a time, trying one again when GitHive says to:
 * each registration and backlog item is a write to one record, and hundreds
 * at once would only contend.
 */
async function inBatches(items, n, fn) {
	const queue = [...items];
	const again = async (item) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await fn(item);
			} catch (err) {
				if (attempt === 5 || !/try again/.test(String(err.message ?? err))) throw err;
				await sleep(1_000 * attempt * (0.5 + Math.random()));
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
		while (queue.length) await again(queue.shift());
	}));
}
// Registered side by side, then the backlog filed side by side, a few at a time: setup takes seconds.
const unregistered = [...plan.agents, ...(plan.planner ? [plan.planner] : [])].filter((who) => who.keyFile && !existsSync(at(who.keyFile)));
await inBatches(unregistered, 1, async (who) => {
	{
		mkdirSync(dirname(at(who.keyFile)), { recursive: true });
		const { key } = await tool("register", { agent: who.agent });
		writeFileSync(at(who.keyFile), key);
		chmodSync(at(who.keyFile), 0o600);
	}
});
if (unregistered.length) say("swarm", `registered ${unregistered.map((w) => w.agent).join(", ")}`);
const planner = plan.planner ?? plan.agents[0];
await inBatches(plan.backlog, 1, async (piece) => {
	const added = await tool("add_work", { id: piece.id, title: piece.title ?? piece.id, intent: piece.intent, ...(piece.paths ? { paths: piece.paths } : {}), agent: planner.agent }, planner.keyFile);
	if (!added.ok && !/already/.test(added.reason ?? "")) throw new Error(`adding ${piece.id} failed: ${added.reason}`);
});
// Setup ends once the repo has a snapshot for check containers to start from, as on a repo that's been running: the work clock starts then.
if (plan.setup?.verify?.length) {
	const until = Date.now() + 6 * 60_000;
	for (;;) {
		const landing = await fetch(`${BASE}/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(branch)}`, { headers: access, dispatcher: patient })
			.then((r) => (r.ok ? r.json() : {}))
			.catch(() => ({}));
		if (landing.snapshot) {
			say("swarm", `the repo's snapshot is ready (${Math.round(landing.snapshot.size / 1e6)} MB)`);
			break;
		}
		if (Date.now() > until) {
			say("swarm", "starting without a snapshot after 6 minutes");
			break;
		}
		await sleep(5_000);
	}
}
const workStarted = Date.now();
const setupSeconds = ((workStarted - started) / 1000).toFixed(0);
// Set up for other agents to work on (real ones, see claude-agents.mjs): the repo, its agents and backlog, nothing run.
if (args.includes("--setup-only")) {
	say("swarm", `set up in ${setupSeconds}s; --setup-only, so no scripted agents run`);
	process.exit(0);
}
/** When the last piece settled (merged, waiting on a person, or stopped): the end of the work. */
let lastSettled = workStarted;
say("swarm", `${plan.backlog.length} pieces in the backlog; ${plan.agents.length} agents, all alike${speed !== 1 ? `, at ${speed}x speed` : ""}`);

await Promise.all(plan.agents.map((spec) => agentFor(spec)()));

const seconds = (ms) => (ms === undefined ? "    -" : `${(ms / 1000).toFixed(0).padStart(4)}s`);
console.log(`\n${"piece".padEnd(16)} builder     claimed  pushed revised approved merged  outcome`);
for (const [id, t] of timeline) {
	console.log(`${id.padEnd(16)} ${(t.builder ?? "-").padEnd(10)} ${seconds(t.claimed)} ${seconds(t.pushed)} ${seconds(t.revised)}  ${seconds(t.approved)} ${seconds(t.merged)}  ${settled.get(id) ?? "unfinished"}`);
	const detail = [...(t.reviews.length ? [`reviews: ${t.reviews.join(", ")}`] : []), ...t.events];
	if (detail.length) console.log(`${"".padEnd(16)} ${detail.join("; ")}`);
}
console.log(`\n${"agent".padEnd(12)} build review revise merge wait`);
for (const [name, d] of did) console.log(`${name.padEnd(12)} ${String(d.build).padStart(5)} ${String(d.review).padStart(6)} ${String(d.revise).padStart(6)} ${String(d.merge).padStart(5)} ${String(d.wait).padStart(4)}`);
const merged = [...settled.values()].filter((s) => s.startsWith("merged")).length;
console.log(`\n${merged} of ${plan.backlog.length} merged. Setup ${setupSeconds}s (once per repo); work ${((lastSettled - workStarted) / 1000).toFixed(0)}s (agents released to the last piece settled); total ${((Date.now() - started) / 1000).toFixed(0)}s`);
const audit = await fetch(`${BASE}/repos/_/${plan.repo}/audit`, { headers: { ...access, "Cache-Control": "no-cache" }, dispatcher: patient }).then((r) => r.json());
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : ""}`);
