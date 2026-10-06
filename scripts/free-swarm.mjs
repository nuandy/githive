#!/usr/bin/env node
// Run scripted outside agents and reviewers on a coordinator-free repo, all
// at once, the way independent agents would work. Each agent arrives on its
// own clock, claims, clones the project, takes its time over its edit,
// pushes to its fork, checks, waits for approval and merges; and recovers
// as an agent would: it extends its claim when a file falls outside it,
// merges the project's branch in when it conflicts, and answers a rejection
// with a fix (or a question for a person). Each reviewer gets the change's
// code through Blueprint (free_review_access), takes its time, runs the tests
// and votes by their exit code. Nothing waits on anything but the protocol: a
// claim held by another change, votes, and the line of merges. Prints each
// step as it happens, then a timeline per change and the audit.
//
//   node scripts/free-swarm.mjs <plan.json> [--base URL] [--speed N]
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
//     "agents": [{ "agent": "lib-agent", "change": "const-lib", "intent": "...", "paths": ["lib/"],
//                  "edit": "node $PLAN/edits/const-requires.mjs . lib", "message": "commit message",
//                  "fix": "node $PLAN/edits/fix.mjs .",   what it does about a rejection (optional)
//                  "onReject": "fix" | "ask" | "stop",     default: fix if it has one, else stop
//                  "reviewers": ["reviewer-1", "security-1"],   its own reviewers (optional)
//                  "keyFile": "keys/lib-agent.key" }],
//     "reviewers": [{ "reviewer": "reviewer-1", "role": "review", "keyFile": "keys/reviewer-1.key",
//                     "rejectFirst": { "const-lib": "what to change" } }],   scripted rejections (optional)
//     "reviewersPerChange": 1,              each change goes to this many general reviewers, in turn
//     "setup": { "import": "https://github.com/expressjs/express", "branch": "master",
//                "verify": ["npm install", "npm test"], "required": 1,
//                "grants": { "security": ["security-1"] } }   optional: make the repo first
//   }
//
// Agents and reviewers whose keyFile doesn't exist yet are registered first
// (free_register), the key written to that file: each needs its own identity,
// or their votes count as one and an author's reviewers as the author.
// An agent's edit and fix run in its clone, with $PLAN set to the plan's
// directory. --base defaults to the bench Worker. Access credentials come
// from .dev.vars. Tokens and keys are never printed.

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
// A merge can wait in line for minutes: no client-side timeouts.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const started = Date.now();
const clock = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const say = (who, text) => console.log(`${clock()}  ${who.padEnd(18)} ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeded timings (mulberry32): the same plan and seed wait the same way.
let seed = plan.seed ?? 1;
const random = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const timing = { arrive: [0, 120], edit: [30, 180], fix: [30, 120], review: [20, 90], ...plan.timing };
/** Seconds to spend on `step`, drawn now (in a fixed order per actor, so runs repeat), already divided by --speed. */
const draw = (step) => {
	const [min, max] = timing[step];
	return ((min + random() * (max - min)) * 1000) / speed;
};

async function tool(name, toolArgs, keyFile) {
	const key = keyFile ? readFileSync(at(keyFile), "utf8").trim() : undefined;
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		dispatcher: patient,
		headers: { ...access, "Content-Type": "application/json", ...(key ? { "X-Blueprint-Agent-Key": key } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: plan.repo, ...toolArgs } } }),
	});
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
let branch = plan.branch ?? plan.setup?.branch ?? "main";

/** Each change's timeline: when each step happened, its heads, what it ran into. */
const timeline = new Map(plan.agents.map((a) => [a.change, { agent: a.agent, heads: [], events: [] }]));
const mark = (change, step) => (timeline.get(change)[step] ??= Date.now() - started);
const note = (change, event) => timeline.get(change).events.push(event);
let agentsLeft = plan.agents.length;

async function agent(spec) {
	const { agent: name, change } = spec;
	const t = timeline.get(change);
	const dir = join(work, change);
	const key = spec.keyFile;
	// Each agent's timings drawn up front, in order, so the run repeats whatever happens.
	const arrive = draw("arrive");
	const editFor = draw("edit");
	const fixFor = draw("fix");
	let paths = [...spec.paths];

	/** Claim (again, to extend), waiting while another change holds what this one needs. */
	const claimPaths = async (wanted) => {
		for (let waited = 0; ; waited += 15) {
			const claimed = await tool("free_claim", { change, agent: name, paths: wanted, intent: spec.intent }, key);
			if (claimed.ok) return;
			const holders = [...new Set((claimed.conflicts ?? []).map((c) => c.change))].join(", ");
			if (waited >= 900) throw new Error(`still blocked by ${holders} after 15 minutes`);
			if (waited === 0) {
				say(name, `waits: ${holders} hold part of what it needs`);
				note(change, `waited on ${holders}`);
			}
			await sleep(15_000);
		}
	};
	const commitAndPush = async (message) => {
		await git(dir, "add", "-A");
		await git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@agents.example`, "commit", "-q", "-m", message);
		await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${change}`);
		const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
		const { stdout: stat } = await git(dir, "show", "--stat", "--format=", "HEAD");
		t.heads.push(head);
		say(name, `pushed ${head.slice(0, 7)}: ${stat.trim().split("\n").at(-1).trim()}`);
		return head;
	};
	/** The project's branch merged into this one (deep enough to find where they meet), and pushed. */
	const mergeProject = async () => {
		await git(dir, "fetch", "-q", "--depth", "50", "origin", branch);
		await git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@agents.example`, "merge", "-q", "--no-edit", `origin/${branch}`).catch(async (err) => {
			await git(dir, "merge", "--abort").catch(() => undefined);
			throw new Error(`conflicts with ${branch} it can't resolve inside its claim: ${String(err.stderr ?? err).slice(0, 160)}`);
		});
		note(change, `merged ${branch} in`);
		await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${change}`);
		const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
		t.heads.push(head);
		say(name, `merged ${branch} in and pushed ${head.slice(0, 7)}`);
	};
	/** Check after a push: extend the claim to files outside it, merge the project in on a conflict. */
	const settle = async () => {
		for (let round = 0; round < 3; round++) {
			const checked = await tool("free_check", { change }, key);
			mark(change, "checked");
			if (checked.outsideClaim?.length) {
				paths = [...new Set([...paths, ...checked.outsideClaim])];
				say(name, `extends its claim to ${checked.outsideClaim.join(", ")}`);
				note(change, `extended claim (${checked.outsideClaim.length})`);
				await claimPaths(paths);
				continue;
			}
			if (checked.main && !checked.main.clean) {
				say(name, `conflicts with ${branch} in ${(checked.main.conflicts ?? []).join(", ")}`);
				await mergeProject();
				continue;
			}
			say(name, "check: merges cleanly, all inside its claim");
			return;
		}
	};

	try {
		await sleep(arrive);
		say(name, `arrives for ${change}`);
		await claimPaths(paths);
		mark(change, "claimed");
		say(name, `claimed ${paths.length} path(s)`);

		await helper("clone", dir, "--repo", plan.repo, "--change", change, ...(key ? ["--key-file", at(key)] : []));
		await git(dir, "checkout", "-q", "-b", `changes/${change}`);
		await sleep(editFor);
		await sh(dir, spec.edit);
		await commitAndPush(spec.message ?? spec.intent);
		mark(change, "pushed");
		await settle();

		let fixed = false;
		const giveUp = Date.now() + 20 * 60_000;
		for (;;) {
			if (Date.now() > giveUp) throw new Error("no approval after 20 minutes");
			const status = await tool("free_status", { change }, key);
			const rejection = status.votes?.find((v) => v.verdict === "reject");
			if (rejection || status.approval.vetoedBy?.length) {
				const why = rejection?.evidence ?? `vetoed by ${status.approval.vetoedBy.join(", ")}`;
				const onReject = spec.onReject ?? (spec.fix ? "fix" : "stop");
				say(name, `${rejection?.reviewer ?? "a reviewer"} asks for changes: ${why.slice(0, 120)}`);
				note(change, `rejected by ${rejection?.reviewer ?? "a veto"}`);
				if (onReject === "fix" && spec.fix && !fixed) {
					fixed = true;
					await sleep(fixFor);
					await sh(dir, spec.fix);
					await commitAndPush(`Address review: ${why.slice(0, 60)}`);
					mark(change, "revised");
					await settle();
					continue;
				}
				if (onReject === "ask") {
					await tool("free_ask_human", { change, agent: name, reason: `A reviewer asked for changes I can't make within this change: ${why}` }, key);
					throw new Error("asked a person; waiting on their vote");
				}
				throw new Error(`changes requested: ${why.slice(0, 160)}`);
			}
			if (!status.approval.approved) {
				await sleep(5_000);
				continue;
			}
			mark(change, "approved");
			const merged = await tool("free_merge", { change, agent: name }, key);
			if (merged.ok) {
				mark(change, "merged");
				t.commit = merged.commit;
				say(name, `merged as ${merged.commit.slice(0, 8)}`);
				return;
			}
			const reasons = (merged.reasons ?? []).join("; ");
			const outside = [...reasons.matchAll(/(\S+) is outside /g)].map((m) => m[1]);
			if (outside.length) {
				paths = [...new Set([...paths, ...outside])];
				say(name, `merge refused: extends its claim to ${outside.join(", ")}`);
				note(change, `extended claim at merge (${outside.length})`);
				await claimPaths(paths);
				continue;
			}
			if (merged.conflicts?.length) {
				say(name, `merge refused: conflicts in ${merged.conflicts.join(", ")}`);
				await mergeProject();
				await settle();
				continue;
			}
			if (/approvals|needs approval/.test(reasons)) {
				// A newer head than the votes: wait for them.
				await sleep(5_000);
				continue;
			}
			throw new Error(`merge refused: ${reasons.slice(0, 300)}`);
		}
	} catch (err) {
		t.failed = String(err.message ?? err).slice(0, 300);
		say(name, `stopped: ${t.failed}`);
	} finally {
		agentsLeft--;
	}
}

async function reviewer(spec) {
	// Each change goes to its own reviewers, or to `per` general reviewers in turn.
	const general = plan.reviewers.filter((r) => (r.role ?? "review") === "review");
	const index = general.indexOf(spec);
	const per = Math.min(plan.reviewersPerChange ?? 1, general.length);
	const mine = plan.agents.filter((a, i) => (a.reviewers ? a.reviewers.includes(spec.reviewer) : index >= 0 && Array.from({ length: per }, (__, k) => (i + k) % general.length).includes(index)));
	const reviewed = new Set();
	const rejected = new Set();
	while (agentsLeft > 0) {
		for (const change of mine) {
			const t = timeline.get(change.change);
			const head = t.heads.at(-1);
			if (!head || reviewed.has(head) || t.failed || t.merged) continue;
			reviewed.add(head);
			const dir = join(work, `review-${spec.reviewer}-${change.change}`);
			try {
				// The change's code through Blueprint, as any outside reviewer gets it.
				rmSync(dir, { recursive: true, force: true });
				const { stdout } = await helper("review-clone", dir, "--repo", plan.repo, "--change", change.change, ...(spec.keyFile ? ["--key-file", at(spec.keyFile)] : []));
				const got = JSON.parse(stdout.trim().split("\n").at(-1));
				if (got.head !== head) {
					// Pushed again meanwhile: review the newest next time round.
					reviewed.delete(head);
					continue;
				}
				const { stdout: stat } = await git(dir, "diff", "--stat", `${got.base}...HEAD`);
				await sleep(draw("review"));
				let verdict = "approve";
				let evidence = `Read the diff (${stat.trim().split("\n").at(-1)?.trim() ?? "no changes"}), within ${change.change}'s claim.`;
				if (plan.test) {
					if (plan.nodeModules && !existsSync(join(dir, "node_modules"))) symlinkSync(at(plan.nodeModules), join(dir, "node_modules"));
					// The test command's exit code decides; its summary lines are the evidence.
					const { stdout: out } = await sh(dir, `${plan.test} > .swarm-test.log 2>&1; echo "exit=$?"; tail -60 .swarm-test.log`);
					const failing = !/^exit=0$/m.test(out);
					const summary = (out.match(/\d+ passing|\d+ failing|\d+ pending|Tests\s+[^\n]*/g) ?? []).join(", ");
					if (failing) verdict = "reject";
					evidence += ` ${plan.test}: ${summary || (failing ? "failed" : "passed")}${failing ? ` (exit ${out.match(/^exit=(\d+)$/m)?.[1]})` : ""}.`;
				}
				// A scripted request for changes, once per change.
				const ask = spec.rejectFirst?.[change.change];
				if (ask && !rejected.has(change.change) && verdict === "approve") {
					rejected.add(change.change);
					verdict = "reject";
					evidence = `${ask} ${evidence}`;
				}
				await tool("free_vote", { commit: head, reviewer: spec.reviewer, role: spec.role ?? "review", verdict, evidence }, spec.keyFile);
				say(spec.reviewer, `${verdict === "approve" ? "approves" : "rejects"} ${change.change} (${head.slice(0, 7)})`);
			} catch (err) {
				reviewed.delete(head);
				say(spec.reviewer, `couldn't review ${change.change} yet: ${String(err.message ?? err).slice(0, 160)}`);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		await sleep(3_000);
	}
}

if (plan.setup) {
	const exists = (await (await fetch(`${BASE}/repos`, { headers: access, dispatcher: patient })).json()).some((r) => r.name === plan.repo);
	if (!exists) {
		say("swarm", `importing ${plan.setup.import} as ${plan.repo}`);
		const imported = await fetch(`${BASE}/repos/import`, { method: "POST", dispatcher: patient, headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ url: plan.setup.import, name: plan.repo, branch: plan.setup.branch }) });
		if (!imported.ok) throw new Error(`import failed: HTTP ${imported.status}`);
	}
	const startedMode = await tool("free_start", { required: plan.setup.required ?? 1, ...(plan.setup.verify ? { verify: plan.setup.verify } : {}), ...(plan.setup.grants ? { grants: plan.setup.grants } : {}) });
	branch = startedMode.branch;
	say("swarm", `${plan.repo} on ${startedMode.branch}: checks ${JSON.stringify(startedMode.verify)}, claims sharded ${JSON.stringify(startedMode.sharding)}`);
}
for (const who of [...plan.agents.map((a) => ({ name: a.agent, keyFile: a.keyFile })), ...plan.reviewers.map((r) => ({ name: r.reviewer, keyFile: r.keyFile }))]) {
	if (!who.keyFile || existsSync(at(who.keyFile))) continue;
	mkdirSync(dirname(at(who.keyFile)), { recursive: true });
	const { key } = await tool("free_register", { agent: who.name });
	writeFileSync(at(who.keyFile), key);
	chmodSync(at(who.keyFile), 0o600);
	say("swarm", `registered ${who.name}`);
}

say("swarm", `${plan.agents.length} agents and ${plan.reviewers.length} reviewers on ${plan.repo}${speed !== 1 ? `, ${speed}x speed` : ""}`);
await Promise.all([...plan.agents.map(agent), ...plan.reviewers.map(reviewer)]);

const seconds = (ms) => (ms === undefined ? "    -" : `${(ms / 1000).toFixed(0).padStart(4)}s`);
console.log(`\n${"change".padEnd(18)} claimed  pushed checked revised approved merged  outcome`);
for (const [change, t] of timeline) {
	const outcome = t.failed ? `stopped: ${t.failed.slice(0, 70)}` : `merged ${t.commit?.slice(0, 8)}`;
	console.log(`${change.padEnd(18)} ${seconds(t.claimed)} ${seconds(t.pushed)} ${seconds(t.checked)} ${seconds(t.revised)}  ${seconds(t.approved)} ${seconds(t.merged)}  ${outcome}${t.events.length ? ` (${t.events.join("; ")})` : ""}`);
}
const merged = [...timeline.values()].filter((t) => t.merged !== undefined).length;
console.log(`\n${merged} of ${timeline.size} merged in ${((Date.now() - started) / 1000).toFixed(0)}s`);
const audit = await fetch(`${BASE}/free/${plan.repo}/audit`, { headers: { ...access, "Cache-Control": "no-cache" }, dispatcher: patient }).then((r) => r.json());
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : ""}`);
