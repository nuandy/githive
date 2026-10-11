#!/usr/bin/env node
// Runs scripted outside agents on a repo at once, the way users send agents.
// Every agent is alike and picks its own work: first its own changes (revise,
// merge or finish), then a review it may give, then a backlog piece. A builder
// claims, clones, edits, pushes to its fork and checks, and recovers as a real
// agent would. A reviewer runs the tests and votes by their exit code. Prints
// each step, then a timeline per piece, each agent's work and the audit.
//
//   node scripts/swarm.mjs <plan.json> [--base URL] [--speed N] [--setup-only]
//
// The plan (paths are relative to the plan's directory):
//   {
//     "repo": "express",
//     "work": "swarm-work",                   where clones go (emptied first)
//     "test": "npm test",                     what reviewers run (optional)
//     "nodeModules": "upstream/node_modules", linked into each reviewer's checkout (optional)
//     "seed": 7,                              seeds the random timings
//     "timing": { "arrive": [0, 120], "edit": [30, 180], "fix": [30, 120], "review": [20, 90] },
//                                             [min, max] seconds; --speed N divides them
//     "agents": [{ "agent": "agent-1", "keyFile": "keys/agent-1.key" }],
//     "planner": { "agent": "planner", "keyFile": "keys/planner.key" },    adds the backlog
//     "backlog": [{ "id": "const-lib", "title": "...", "intent": "...", "paths": ["lib/"],
//                   "edit": "node $PLAN/edits/const-requires.mjs . lib", "message": "commit message",
//                   "fix": "node $PLAN/edits/fix.mjs .",    run on a rejection (optional)
//                   "onReject": "fix" | "ask" | "stop",     default: fix if there is one, else stop
//                   "rejectFirst": "what to change" }],     first review asks for changes (optional)
//     "setup": { "import": "https://github.com/expressjs/express", "branch": "master",
//                "template": "express-template",   imported once; each run copies it
//                "owner": "nuandy",               optional: adopt the new repo into this person's or org's namespace
//                "verify": ["npm install", "npm test"], "required": 1,
//                "grants": { "security": ["agent-3"] },
//                "shardDepth": 2,                   shard the claims from the start (optional)
//                "snapshot": false }                don't wait for the Gate's snapshot (a Worker landing with trees
//                                                   starts no Gate on a repo without checks)
//   }
//
// Agents without a key file are registered first and the key is written there.
// Each needs its own identity so votes count separately. Edits and fixes run in
// the builder's clone with $PLAN set to the plan's directory. --base defaults
// to the bench Worker; Access credentials come from .dev.vars. Tokens and keys
// are never printed.

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Agent, fetch } from "undici";
import { BENCH_BASE, ROOT, accessHeaders, parseFlags } from "./lib/bench-client.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const planPath = resolve(args[0] ?? "");
const flags = parseFlags(args);
const BASE = flags.base ?? BENCH_BASE;
const speed = Number(flags.speed ?? 1);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const here = dirname(planPath);
const at = (path) => (path && !isAbsolute(path) ? join(here, path) : path);
const access = accessHeaders();
// A merge can wait minutes for its batch, so there are no client-side timeouts.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
/** The whole run gives up after this long. */
const RUN_LIMIT_MS = 60 * 60_000;

const started = Date.now();
const clock = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const say = (who, text) => console.log(`${clock()}  ${who.padEnd(12)} ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeded timings (mulberry32), so the same plan and seed can be repeated.
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

/** Attempts for a call whose connection dropped. */
const CALL_TRIES = 4;

async function tool(name, toolArgs, keyFile) {
	const key = keyFile ? readFileSync(at(keyFile), "utf8").trim() : undefined;
	const request = () =>
		fetch(`${BASE}/mcp`, {
			method: "POST",
			dispatcher: patient,
			headers: { ...access, "Content-Type": "application/json", ...(key ? { "X-GitHive-Agent-Key": key } : {}) },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: { repo: plan.repo, ...toolArgs } },
			}),
		});
	// Retry only network failures (fetch throws a TypeError), never GitHive's answers.
	// Every call this script makes is safe to repeat.
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

const sh = (cwd, command) =>
	run("bash", ["-lc", command], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PLAN: here } });
/**
 * Limits concurrent network Git on this machine and retries local network
 * failures. Too many at once exhausts local DNS, which says nothing about GitHive.
 */
const NETWORK_AT_ONCE = 32;
const NETWORK_TRIES = 3;
const LOCAL_NETWORK = /Could not resolve host|Failed to connect|Connection reset|SSL_ERROR_SYSCALL|Recv failure/i;
let networking = 0;
const waitingForNetwork = [];
async function onNetwork(work) {
	if (networking >= NETWORK_AT_ONCE) await new Promise((resolve) => waitingForNetwork.push(resolve));
	networking++;
	try {
		for (let attempt = 1; ; attempt++) {
			try {
				return await work();
			} catch (err) {
				if (attempt === NETWORK_TRIES || !LOCAL_NETWORK.test(String(err.stderr ?? err.message ?? err))) throw err;
				await sleep(2_000 * attempt);
			}
		}
	} finally {
		networking--;
		waitingForNetwork.shift()?.();
	}
}
const NETWORK_GIT = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);
const git = (cwd, ...rest) => {
	const call = () => run("git", ["-C", cwd, ...rest], { maxBuffer: 64 * 1024 * 1024 });
	return NETWORK_GIT.has(rest.find((r) => !r.startsWith("-"))) ? onNetwork(call) : call();
};
const helper = (...rest) =>
	onNetwork(() =>
		run("node", [join(ROOT, "scripts/mcp-agent.mjs"), ...rest, "--base", BASE], { maxBuffer: 16 * 1024 * 1024 }),
	);

const work = at(plan.work ?? "swarm-work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
let branch = plan.setup?.branch ?? "main";

const pieces = new Map(plan.backlog.map((p) => [p.id, p]));
/** Each piece's timeline: when each step happened, who did it and what went wrong. */
const timeline = new Map(plan.backlog.map((p) => [p.id, { heads: [], reviews: [], events: [] }]));
const mark = (id, step) => (timeline.get(id)[step] ??= Date.now() - started);
const note = (id, event) => timeline.get(id).events.push(event);
/** What each agent did, by kind of step. */
const did = new Map(plan.agents.map((a) => [a.agent, { build: 0, review: 0, revise: 0, merge: 0, wait: 0 }]));
/** Pieces whose rejectFirst review has already happened. */
const askedOnce = new Set();
/** Pieces settled for this run: merged, waiting on a person, or stopped. */
const settled = new Map();
const settlePiece = (id, outcome) => {
	settled.set(id, outcome);
	lastSettled = Date.now();
};
const allSettled = () => plan.backlog.every((p) => settled.has(p.id));
/**
 * Settles pieces that landed in another merge's batch. A merge lands every
 * approved change, so a piece's own agent may never be told to merge it.
 */
let landingsReadAt = 0;
async function settleLanded() {
	if (Date.now() - landingsReadAt < 5_000) return;
	landingsReadAt = Date.now();
	const landing = await fetch(`${BASE}/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(branch)}`, {
		headers: access,
		dispatcher: patient,
	})
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null);
	for (const outcome of landing?.recent ?? []) {
		const { change, commit } = outcome;
		if (outcome.how !== "landed" || settled.has(change) || !timeline.has(change)) continue;
		const pieceTimeline = timeline.get(change);
		pieceTimeline.merged ??= Date.parse(outcome.at) - started;
		pieceTimeline.commit = commit;
		settlePiece(change, `merged ${commit.slice(0, 8)}`);
		say("swarm", `${change} landed as ${commit.slice(0, 8)}, in another merge's batch`);
	}
}

const checkoutOf = (id) => join(work, id);
const keyFileArgs = (agent) => (agent.keyFile ? ["--key-file", at(agent.keyFile)] : []);
/** Git options that commit as the agent. */
const identity = (agent) => ["-c", `user.name=${agent.name}`, "-c", `user.email=${agent.name}@agents.example`];

async function commitAndPush(agent, id, message) {
	const dir = checkoutOf(id);
	await git(dir, "add", "-A");
	await git(dir, ...identity(agent), "commit", "-q", "-m", message);
	await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${id}`);
	const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
	const { stdout: stat } = await git(dir, "show", "--stat", "--format=", "HEAD");
	const statSummary = stat.trim().split("\n").at(-1).trim();
	timeline.get(id).heads.push(head);
	say(agent.name, `pushed ${id} ${head.slice(0, 7)}: ${statSummary}`);
}

/**
 * Merges the project's branch in and pushes. The fetch has no depth, so it joins the history already here and the
 * push sends the fork every commit it lacks.
 */
async function mergeProject(agent, id) {
	const dir = checkoutOf(id);
	await git(dir, "fetch", "-q", "origin", branch);
	await git(dir, ...identity(agent), "merge", "-q", "--no-edit", `origin/${branch}`).catch(async (err) => {
		await git(dir, "merge", "--abort").catch(() => undefined);
		const detail = String(err.stderr ?? err).slice(0, 160);
		throw new Error(`conflicts with ${branch} it can't resolve inside its claim: ${detail}`);
	});
	note(id, `merged ${branch} in`);
	await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${id}`);
	const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
	timeline.get(id).heads.push(head);
	say(agent.name, `merged ${branch} into ${id} and pushed`);
}

async function extendClaim(agent, id, files, when) {
	const paths = [...new Set([...(agent.claimed.get(id) ?? []), ...files])];
	const piece = pieces.get(id);
	const result = await agent.call("claim", { change: id, agent: agent.name, paths, intent: piece.intent });
	if (!result.ok) {
		const detail = JSON.stringify(result.conflicts ?? result).slice(0, 160);
		throw new Error(`couldn't extend its claim to ${files.join(", ")}: ${detail}`);
	}
	agent.claimed.set(id, paths);
	note(id, `extended claim ${when} (${files.length})`);
	say(agent.name, `extends ${id}'s claim to ${files.join(", ")}`);
}

/** After a push, extends the claim to files outside it and merges the project in on a conflict. */
async function checkPushed(agent, id) {
	for (let round = 0; round < 3; round++) {
		const { merge: checked = {} } = await agent.call("status", { change: id });
		mark(id, "checked");
		if (checked.outsideClaim?.length) {
			await extendClaim(agent, id, checked.outsideClaim, "at check");
			continue;
		}
		if (checked.clean === false) {
			await mergeProject(agent, id);
			continue;
		}
		return;
	}
}

/** Claims a backlog piece for the agent; false when another agent claimed it first. */
async function claimPiece(agent, piece, paths) {
	const result = await agent
		.call("claim", { change: piece.id, agent: agent.name, paths, intent: piece.intent })
		.catch((err) => ({ ok: false, error: String(err.message ?? err) }));
	if (!result.ok) {
		const reason = result.error ?? JSON.stringify(result.conflicts);
		say(agent.name, `couldn't claim ${piece.id}: ${reason.slice(0, 100)}`);
		return false;
	}
	agent.claimed.set(piece.id, paths);
	timeline.get(piece.id).builder = agent.name;
	mark(piece.id, "claimed");
	return true;
}

async function buildPiece(agent, item) {
	const piece = pieces.get(item.id);
	if (!piece) throw new Error(`the backlog has ${item.id}, which isn't in this plan's`);
	const paths = piece.paths ?? item.paths ?? [];
	if (!(await claimPiece(agent, piece, paths))) return;
	say(agent.name, `builds ${piece.id} (${paths.length} path(s))`);
	const dir = checkoutOf(piece.id);
	// A build that failed before pushing starts over from a fresh clone.
	rmSync(dir, { recursive: true, force: true });
	await helper("clone", dir, "--repo", plan.repo, "--change", piece.id, ...keyFileArgs(agent));
	await git(dir, "checkout", "-q", "-b", `changes/${piece.id}`);
	await sleep(draw("edit"));
	await sh(dir, piece.edit);
	await commitAndPush(agent, piece.id, piece.message ?? piece.intent);
	mark(piece.id, "pushed");
	await checkPushed(agent, piece.id);
}

/** Runs the plan's tests in a reviewer's checkout: whether they failed, and the evidence to add for them. */
async function runTests(dir) {
	if (plan.nodeModules && !existsSync(join(dir, "node_modules")))
		symlinkSync(at(plan.nodeModules), join(dir, "node_modules"));
	// The exit code decides the verdict. The summary lines are the evidence.
	const { stdout: out } = await sh(
		dir,
		`${plan.test} > .swarm-test.log 2>&1; echo "exit=$?"; tail -60 .swarm-test.log`,
	);
	const failing = !/^exit=0$/m.test(out);
	const summary = (out.match(/\d+ passing|\d+ failing|\d+ pending|Tests\s+[^\n]*/g) ?? []).join(", ");
	const outcome = summary || (failing ? "failed" : "passed");
	const exitCode = out.match(/^exit=(\d+)$/m)?.[1];
	const exitNote = failing ? ` (exit ${exitCode})` : "";
	return { failing, evidence: ` ${plan.test}: ${outcome}${exitNote}.` };
}

/** The verdict on a change and its evidence: the diff read, the plan's tests, and a rejectFirst ask. */
async function judge(dir, change, diffStat) {
	let verdict = "approve";
	let evidence = `Read the diff (${diffStat.trim().split("\n").at(-1)?.trim() ?? "no changes"}).`;
	if (plan.test) {
		const tests = await runTests(dir);
		if (tests.failing) verdict = "reject";
		evidence += tests.evidence;
	}
	// rejectFirst makes the piece's first review ask for changes.
	const rejectFirst = pieces.get(change)?.rejectFirst;
	if (rejectFirst && verdict === "approve" && !askedOnce.has(change)) {
		askedOnce.add(change);
		verdict = "reject";
		evidence = `${rejectFirst} ${evidence}`;
	}
	return { verdict, evidence };
}

async function reviewChange(agent, step) {
	const dir = join(work, `review-${agent.name}-${step.change}`);
	rmSync(dir, { recursive: true, force: true });
	try {
		const { stdout } = await helper(
			"review-clone",
			dir,
			"--repo",
			plan.repo,
			"--change",
			step.change,
			"--role",
			step.role,
			...keyFileArgs(agent),
		);
		const checkout = JSON.parse(stdout.trim().split("\n").at(-1));
		if (checkout.head !== step.head) return; // pushed again since; ask again
		const { stdout: diffStat } = await git(dir, "diff", "--stat", `${checkout.base}...HEAD`);
		await sleep(draw("review"));
		const { verdict, evidence } = await judge(dir, step.change, diffStat);
		await agent.call("vote", { commit: step.head, reviewer: agent.name, role: step.role, verdict, evidence });
		const asRole = step.role !== "review" ? ` as ${step.role}` : "";
		const action = verdict === "approve" ? "approves" : "rejects";
		timeline.get(step.change)?.reviews.push(`${agent.name}${asRole}: ${verdict}`);
		say(agent.name, `${action} ${step.change} (${step.head.slice(0, 7)})${asRole}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function reviseChange(agent, step) {
	const piece = pieces.get(step.change);
	const onReject = piece?.onReject ?? (piece?.fix ? "fix" : "stop");
	note(step.change, `rejected by ${step.reviewer}`);
	say(agent.name, `${step.reviewer} asks for changes to ${step.change}: ${step.evidence.slice(0, 100)}`);
	if (onReject === "fix" && piece?.fix && !timeline.get(step.change).revised) {
		await sleep(draw("fix"));
		await sh(checkoutOf(step.change), piece.fix);
		await commitAndPush(agent, step.change, `Address review: ${step.evidence.slice(0, 60)}`);
		mark(step.change, "revised");
		await checkPushed(agent, step.change);
		return;
	}
	if (onReject === "ask") {
		await agent.call("ask_human", {
			change: step.change,
			agent: agent.name,
			reason: `A reviewer asked for changes I shouldn't decide alone: ${step.evidence}`,
		});
		note(step.change, "asked a person");
		settlePiece(step.change, "waits on a person");
		say(agent.name, `asks a person about ${step.change}`);
		return;
	}
	settlePiece(step.change, `stopped: changes requested (${step.evidence.slice(0, 60)})`);
	await agent.call("release", {
		change: step.change,
		agent: agent.name,
		reason: "a reviewer asked for changes I can't make",
	});
}

async function mergeChange(agent, step) {
	mark(step.change, "approved");
	const merged = await agent.call("merge", { change: step.change, agent: agent.name });
	if (merged.ok) {
		mark(step.change, "merged");
		timeline.get(step.change).commit = merged.commit;
		settlePiece(step.change, `merged ${merged.commit.slice(0, 8)}`);
		say(agent.name, `merged ${step.change} as ${merged.commit.slice(0, 8)}`);
		return;
	}
	const reasons = (merged.reasons ?? []).join("; ");
	const outside = [...reasons.matchAll(/(\S+) is outside /g)].map((match) => match[1]);
	if (outside.length) return extendClaim(agent, step.change, outside, "at merge");
	if (merged.conflicts?.length) {
		await mergeProject(agent, step.change);
		return checkPushed(agent, step.change);
	}
	say(agent.name, `merge of ${step.change} refused: ${reasons.slice(0, 160)}`);
	note(step.change, `merge refused: ${reasons.slice(0, 60)}`);
}

/**
 * Returns the first of the agent's own changes that needs action: revise, merge, or
 * finish one with nothing pushed. Changes that landed are dropped.
 */
async function ownStep(agent) {
	for (const id of agent.claimed.keys()) {
		if (settled.has(id)) continue;
		const status = await agent.call("status", { change: id });
		const mergedAs = status.landed?.commit ?? status.released?.mergedAs;
		const over = mergedAs || (!status.claim && status.released);
		if (over) {
			agent.claimed.delete(id);
			if (mergedAs && !settled.has(id)) {
				mark(id, "merged");
				timeline.get(id).commit = mergedAs;
				settlePiece(id, `merged ${mergedAs.slice(0, 8)}`);
			}
			continue;
		}
		if (!status.head) return { kind: "finish", change: id };
		const rejection = status.votes.find(
			(vote) => vote.commit === status.head && vote.verdict === "reject" && vote.reviewer !== agent.name,
		);
		if (rejection)
			return {
				kind: "revise",
				change: id,
				head: status.head,
				reviewer: rejection.reviewer,
				evidence: rejection.evidence,
			};
		if (status.approval?.approved) return { kind: "merge", change: id, head: status.head };
	}
	return null;
}

/** Nobody assigns work. Own changes come first, then a review, then the backlog; null when there's none. */
async function nextStep(agent) {
	const own = await ownStep(agent);
	if (own) return own;
	const { reviews } = await agent.call("reviews", { agent: agent.name });
	if (reviews.length) return { kind: "review", ...reviews[0] };
	// Skip backlog items left over from earlier runs.
	const { open } = await agent.call("backlog", { agent: agent.name });
	const ours = open.filter((item) => pieces.has(item.id));
	if (ours.length) return { kind: "build", work: ours[0] };
	return null;
}

async function takeStep(agent, step) {
	const kindCounted = step.kind === "finish" ? "build" : step.kind;
	did.get(agent.name)[kindCounted]++;
	if (step.kind === "build") await buildPiece(agent, step.work);
	else if (step.kind === "finish") await buildPiece(agent, { id: step.change });
	else if (step.kind === "review") await reviewChange(agent, step);
	else if (step.kind === "revise") await reviseChange(agent, step);
	else if (step.kind === "merge") await mergeChange(agent, step);
}

/** Why a step failed. A failed command's message is mostly its command line. Its last output says why it failed. */
const failureOf = (err) =>
	err.stderr ? String(err.stderr).trim().split("\n").slice(-2).join(" | ") : String(err.message ?? err);

/** The agent's loop: take the next step, or wait for one, until every piece settles or the run's time is up. */
async function runAgent(agent) {
	await sleep(draw("arrive"));
	say(agent.name, "arrives");
	const until = started + RUN_LIMIT_MS;
	while (Date.now() < until) {
		let step;
		try {
			step = await nextStep(agent);
			if (step) {
				await takeStep(agent, step);
				continue;
			}
			did.get(agent.name).wait++;
			await settleLanded();
			if (allSettled()) break;
			// A merge or review can free work at any time.
			await sleep(5_000);
		} catch (err) {
			const id = step?.change ?? step?.work?.id;
			say(agent.name, `${step?.kind ?? "look"}${id ? ` ${id}` : ""} failed: ${failureOf(err).slice(0, 300)}`);
			if (id && timeline.has(id)) note(id, `${step.kind} failed`);
			await sleep(10_000);
		}
	}
	say(agent.name, "done");
}

/** One agent: build, review, revise and merge, as it chooses. */
function agentFor(spec) {
	const agent = {
		name: spec.agent,
		keyFile: spec.keyFile,
		/** The paths claimed for each of its changes. */
		claimed: new Map(),
		call: (toolName, toolArgs) => tool(toolName, toolArgs, spec.keyFile),
	};
	return () => runAgent(agent);
}

const post = (path, body) =>
	fetch(`${BASE}${path}`, {
		method: "POST",
		dispatcher: patient,
		headers: { ...access, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
if (plan.setup) {
	const listed = await (await fetch(`${BASE}/repos`, { headers: access, dispatcher: patient })).json();
	// By id: a repo adopted into an owner is listed as owner/name, but its id stays the name the swarm made it with.
	const repos = new Set(listed.map((repo) => repo.id));
	if (!repos.has(plan.repo)) {
		const template = plan.setup.template;
		if (template && !repos.has(template)) {
			say("swarm", `importing ${plan.setup.import} as ${template}, once`);
			const imported = await post("/repos/import", {
				url: plan.setup.import,
				name: template,
				branch: plan.setup.branch,
			});
			if (!imported.ok) throw new Error(`import failed: HTTP ${imported.status}`);
		}
		say("swarm", template ? `copying ${template} as ${plan.repo}` : `importing ${plan.setup.import} as ${plan.repo}`);
		const made = template
			? await post(`/repos/_/${template}/copy`, { name: plan.repo })
			: await post("/repos/import", { url: plan.setup.import, name: plan.repo, branch: plan.setup.branch });
		if (!made.ok)
			throw new Error(`making ${plan.repo} failed: HTTP ${made.status} ${(await made.text()).slice(0, 200)}`);
		// In a person's namespace from the start, so it shows on their dashboard; calls by its id still reach it.
		if (plan.setup.owner) {
			const adopted = await post(`/admin/repos/${plan.repo}/adopt`, { owner: plan.setup.owner, name: plan.repo });
			if (!adopted.ok)
				throw new Error(`adopting ${plan.repo} failed: HTTP ${adopted.status} ${(await adopted.text()).slice(0, 200)}`);
			say("swarm", `${plan.repo} is ${plan.setup.owner}/${plan.repo}`);
		}
	}
	const settings = { required: plan.setup.required ?? 1 };
	if (plan.setup.verify) settings.verify = plan.setup.verify;
	if (plan.setup.grants) settings.grants = plan.setup.grants;
	if (plan.setup.shardDepth !== undefined) settings.shard_depth = plan.setup.shardDepth;
	const applied = await tool("settings", settings);
	branch = applied.branch;
	const checks = JSON.stringify(applied.verify);
	const grants = JSON.stringify(applied.policy?.grants ?? {});
	const sharding = JSON.stringify(applied.sharding);
	say("swarm", `${plan.repo} on ${branch}: checks ${checks}, grants ${grants}, claims ${sharding}`);
}
const chunks = (items, n) =>
	Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));

/** Runs `fn` over `items`, `n` at a time, retrying when GitHive says to try again. */
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
	await Promise.all(
		Array.from({ length: Math.min(n, queue.length) }, async () => {
			while (queue.length) await again(queue.shift());
		}),
	);
}
// Register agents and file the backlog a list at a time. One write per list is much faster than one per item.
const LIST_AT_ONCE = 250;
const unregistered = [...plan.agents, ...(plan.planner ? [plan.planner] : [])].filter(
	(who) => who.keyFile && !existsSync(at(who.keyFile)),
);
await inBatches(chunks(unregistered, LIST_AT_ONCE), 1, async (list) => {
	const { agents } = await tool("register", { agents: list.map((who) => who.agent) });
	for (const who of list) {
		mkdirSync(dirname(at(who.keyFile)), { recursive: true });
		writeFileSync(at(who.keyFile), agents.find((a) => a.agent === who.agent).key);
		chmodSync(at(who.keyFile), 0o600);
	}
});
if (unregistered.length)
	say("swarm", `registered ${unregistered.length} agents (${unregistered[0].agent} to ${unregistered.at(-1).agent})`);
const planner = plan.planner ?? plan.agents[0];
await inBatches(chunks(plan.backlog, LIST_AT_ONCE), 1, async (list) => {
	const items = list.map((piece) => ({
		id: piece.id,
		title: piece.title ?? piece.id,
		intent: piece.intent,
		...(piece.paths ? { paths: piece.paths } : {}),
	}));
	const added = await tool("add_work", { items, agent: planner.agent }, planner.keyFile);
	if (!added.ok && !added.already?.length)
		throw new Error(`adding ${list[0].id} to ${list.at(-1).id} failed: ${JSON.stringify(added)}`);
});
// Wait for the repo's container snapshot, as on a repo that has been running. The work clock starts after setup.
if (plan.setup && plan.setup.snapshot !== false) {
	const until = Date.now() + 6 * 60_000;
	for (;;) {
		const landing = await fetch(`${BASE}/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(branch)}`, {
			headers: access,
			dispatcher: patient,
		})
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
// Also wait for the agents' forks. GitHive makes them a few at a time after registration, and builds fail without them.
{
	const until = Date.now() + 30 * 60_000;
	let said = 0;
	for (;;) {
		const forks = await fetch(`${BASE}/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(branch)}`, {
			headers: access,
			dispatcher: patient,
		})
			.then((r) => (r.ok ? r.json() : {}))
			.then((landing) => landing.forks)
			.catch(() => undefined);
		const left = forks ? forks.seedsQueued + forks.agentsQueued : undefined;
		if (left === 0) {
			say("swarm", `the agents' forks are made (${forks.seedsReady} seeds)`);
			break;
		}
		if (Date.now() > until) {
			say("swarm", `starting with ${left ?? "an unknown number of"} forks still to make after 30 minutes`);
			break;
		}
		if (Date.now() - said > 60_000) {
			say(
				"swarm",
				forks
					? `waiting for forks: ${forks.seedsQueued} seeds and ${forks.agentsQueued} agents' forks to make`
					: "waiting for forks",
			);
			said = Date.now();
		}
		await sleep(5_000);
	}
}
const workStarted = Date.now();
const setupSeconds = ((workStarted - started) / 1000).toFixed(0);
// Prepare the repo, agents and backlog for real agents (see claude-agents.mjs) without running any.
if (args.includes("--setup-only")) {
	say("swarm", `set up in ${setupSeconds}s; --setup-only, so no scripted agents run`);
	process.exit(0);
}
/** When the last piece settled. This marks the end of the work. */
let lastSettled = workStarted;
const pace = speed !== 1 ? `, at ${speed}x speed` : "";
say("swarm", `${plan.backlog.length} pieces in the backlog; ${plan.agents.length} agents, all alike${pace}`);

await Promise.all(plan.agents.map((spec) => agentFor(spec)()));

const seconds = (ms) => (ms === undefined ? "    -" : `${(ms / 1000).toFixed(0).padStart(4)}s`);
console.log(`\n${"piece".padEnd(16)} builder     claimed  pushed revised approved merged  outcome`);
for (const [id, steps] of timeline) {
	const builder = (steps.builder ?? "-").padEnd(10);
	const outcome = settled.get(id) ?? "unfinished";
	const times = [steps.claimed, steps.pushed, steps.revised].map(seconds).join(" ");
	const ends = [steps.approved, steps.merged].map(seconds).join(" ");
	console.log(`${id.padEnd(16)} ${builder} ${times}  ${ends}  ${outcome}`);
	const reviews = steps.reviews.length ? [`reviews: ${steps.reviews.join(", ")}`] : [];
	const detail = [...reviews, ...steps.events];
	if (detail.length) console.log(`${"".padEnd(16)} ${detail.join("; ")}`);
}
console.log(`\n${"agent".padEnd(12)} build review revise merge wait`);
for (const [name, counts] of did) {
	const column = (kind, width) => String(counts[kind]).padStart(width);
	const columns = [column("build", 5), column("review", 6), column("revise", 6), column("merge", 5), column("wait", 4)];
	console.log(`${name.padEnd(12)} ${columns.join(" ")}`);
}
const merged = [...settled.values()].filter((outcome) => outcome.startsWith("merged")).length;
const workSeconds = ((lastSettled - workStarted) / 1000).toFixed(0);
const totalSeconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(
	`\n` +
		`${merged} of ${plan.backlog.length} merged. Setup ${setupSeconds}s (once per repo); work ${workSeconds}s ` +
		`(agents released to the last piece settled); total ${totalSeconds}s`,
);
const audit = await fetch(`${BASE}/repos/_/${plan.repo}/audit`, {
	headers: { ...access, "Cache-Control": "no-cache" },
	dispatcher: patient,
}).then((r) => r.json());
const violations = audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : "";
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${violations}`);
