#!/usr/bin/env node
// Run scripted outside agents and reviewers on a coordinator-free repo, all
// at once, the way independent agents would work: each agent claims, clones
// the project, makes its edit, pushes to its fork, checks, waits for
// approval and merges, on its own clock; each reviewer watches the changes
// it's assigned, runs the tests on each pushed commit and votes. Nothing
// waits on anything but the protocol: a claim held by another change, votes,
// and the line of merges. Prints each step as it happens, then a timeline
// per change and the audit.
//
//   node scripts/free-swarm.mjs <plan.json> [--base URL]
//
// The plan (paths in it are relative to the plan's own directory):
//   {
//     "repo": "express",
//     "work": "swarm-work",                  where clones go (emptied first)
//     "test": "npm test",                    what reviewers run on each commit (optional)
//     "nodeModules": "upstream/node_modules", linked into each reviewer's checkout (optional)
//     "agents": [{ "agent": "lib-agent", "change": "const-lib", "intent": "...", "paths": ["lib/"],
//                  "edit": "node $PLAN/edits/const-requires.mjs . lib", "message": "commit message",
//                  "keyFile": "keys/lib-agent.key" }],
//     "reviewers": [{ "reviewer": "reviewer-1", "role": "review", "keyFile": "keys/reviewer-1.key" }],
//     "reviewersPerChange": 1,              each change goes to this many reviewers, in turn
//                                           (or an agent's own "reviewers": ["reviewer-1", "security-1"])
//     "setup": { "import": "https://github.com/expressjs/express", "branch": "master",
//                "verify": ["npm install", "npm test"], "required": 1 }   optional: make the repo first
//   }
//
// Agents and reviewers whose keyFile doesn't exist yet are registered first
// (free_register), the key written to that file: each needs its own identity,
// or their votes count as one and an author's reviewers as the author.
//
// An agent's edit runs in its clone, with $PLAN set to the plan's directory.
// --base defaults to the bench Worker. Access credentials come from .dev.vars.
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

const work = at(plan.work ?? "swarm-work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** Each change's timeline, and whether its agent is done. */
const timeline = new Map(plan.agents.map((a) => [a.change, { agent: a.agent }]));
const mark = (change, step) => (timeline.get(change)[step] = Date.now() - started);
let agentsLeft = plan.agents.length;

async function agent(spec) {
	const { agent: name, change } = spec;
	const dir = join(work, change);
	try {
		// Claim, waiting while another change holds what this one needs.
		for (let waited = 0; ; waited += 15) {
			const claimed = await tool("free_claim", { change, agent: name, paths: spec.paths, intent: spec.intent }, spec.keyFile);
			if (claimed.ok) break;
			const holders = [...new Set((claimed.conflicts ?? []).map((c) => c.change))].join(", ");
			if (waited >= 600) throw new Error(`still blocked by ${holders} after 10 minutes`);
			if (waited === 0) say(name, `waits: ${holders} hold part of its paths`);
			await sleep(15_000);
		}
		mark(change, "claimed");
		say(name, `claimed ${spec.paths.length} path(s) for ${change}`);

		await run("node", [join(root, "scripts/mcp-agent.mjs"), "clone", dir, "--repo", plan.repo, "--change", change, ...(spec.keyFile ? ["--key-file", at(spec.keyFile)] : []), "--base", BASE], { maxBuffer: 16 * 1024 * 1024 });
		await git(dir, "checkout", "-q", "-b", `changes/${change}`);
		await sh(dir, spec.edit);
		await git(dir, "add", "-A");
		await git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@agents.example`, "commit", "-q", "-m", spec.message ?? spec.intent);
		await git(dir, "push", "-q", "fork", `HEAD:refs/heads/changes/${change}`);
		const { stdout: stat } = await git(dir, "show", "--stat", "--format=", "HEAD");
		timeline.get(change).head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
		mark(change, "pushed");
		say(name, `pushed ${timeline.get(change).head.slice(0, 7)}: ${stat.trim().split("\n").at(-1).trim()}`);

		const checked = await tool("free_check", { change }, spec.keyFile);
		mark(change, "checked");
		say(name, `check: ${checked.main?.clean ? "merges cleanly" : `conflicts in ${(checked.main?.conflicts ?? []).join(", ")}`}`);

		// Wait for the reviewers.
		for (;;) {
			const status = await tool("free_status", { change }, spec.keyFile);
			const { approval } = status;
			if (approval.vetoedBy?.length || status.votes?.some((v) => v.verdict === "reject")) {
				const rejection = status.votes.find((v) => v.verdict === "reject");
				throw new Error(`changes requested by ${rejection?.reviewer ?? approval.vetoedBy.join(", ")}: ${(rejection?.evidence ?? "").slice(0, 160)}`);
			}
			if (approval.approved) break;
			await sleep(5_000);
		}
		mark(change, "approved");
		say(name, "approved; merging");

		const merged = await tool("free_merge", { change, agent: name }, spec.keyFile);
		if (!merged.ok) throw new Error(`merge refused: ${(merged.reasons ?? []).join("; ").slice(0, 300)}`);
		mark(change, "merged");
		timeline.get(change).commit = merged.commit;
		say(name, `merged as ${merged.commit.slice(0, 8)}`);
	} catch (err) {
		timeline.get(change).failed = String(err.message ?? err).slice(0, 300);
		say(name, `stopped: ${timeline.get(change).failed}`);
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
	while (agentsLeft > 0) {
		for (const change of mine) {
			const t = timeline.get(change.change);
			if (!t.head || reviewed.has(t.head) || t.failed || t.merged) continue;
			reviewed.add(t.head);
			const dir = join(work, `review-${spec.reviewer}-${change.change}`);
			try {
				// The change's commit, from the agent's clone, on top of the project as the agent started it.
				await run("git", ["clone", "-q", "--no-hardlinks", join(work, change.change), dir]);
				await git(dir, "checkout", "-q", t.head);
				const { stdout: stat } = await git(dir, "show", "--stat", "--format=", t.head);
				let verdict = "approve";
				let evidence = `Diff: ${stat.trim().split("\n").at(-1).trim()}, within ${change.paths.join(", ")}.`;
				if (plan.test) {
					if (plan.nodeModules && !existsSync(join(dir, "node_modules"))) symlinkSync(at(plan.nodeModules), join(dir, "node_modules"));
					// The test command's exit code decides; its summary lines are the evidence.
					const { stdout } = await sh(dir, `${plan.test} > .swarm-test.log 2>&1; echo "exit=$?"; tail -60 .swarm-test.log`);
					const failing = !/^exit=0$/m.test(stdout);
					const summary = (stdout.match(/\d+ passing|\d+ failing|\d+ pending|Tests\s+[^\n]*/g) ?? []).join(", ");
					if (failing) verdict = "reject";
					evidence += ` ${plan.test}: ${summary || (failing ? "failed" : "passed")}${failing ? ` (exit ${stdout.match(/^exit=(\d+)$/m)?.[1]})` : ""}.`;
				}
				await tool("free_vote", { commit: t.head, reviewer: spec.reviewer, role: spec.role ?? "review", verdict, evidence }, spec.keyFile);
				mark(change.change, `voted:${spec.reviewer}`);
				say(spec.reviewer, `${verdict === "approve" ? "approves" : "rejects"} ${change.change} (${t.head.slice(0, 7)})`);
			} catch (err) {
				reviewed.delete(t.head);
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
	const startedMode = await tool("free_start", { required: plan.setup.required ?? 1, ...(plan.setup.verify ? { verify: plan.setup.verify } : {}) });
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

say("swarm", `${plan.agents.length} agents and ${plan.reviewers.length} reviewers on ${plan.repo}, all at once`);
await Promise.all([...plan.agents.map(agent), ...plan.reviewers.map(reviewer)]);

const seconds = (ms) => (ms === undefined ? "    -" : `${(ms / 1000).toFixed(0).padStart(4)}s`);
console.log(`\n${"change".padEnd(22)} claimed  pushed checked approved  merged  outcome`);
for (const [change, t] of timeline) console.log(`${change.padEnd(22)} ${seconds(t.claimed)} ${seconds(t.pushed)} ${seconds(t.checked)}   ${seconds(t.approved)} ${seconds(t.merged)}  ${t.failed ? `stopped: ${t.failed.slice(0, 80)}` : `merged ${t.commit?.slice(0, 8)}`}`);
const merged = [...timeline.values()].filter((t) => t.merged).length;
console.log(`\n${merged} of ${timeline.size} merged in ${((Date.now() - started) / 1000).toFixed(0)}s`);
const audit = await fetch(`${BASE}/free/${plan.repo}/audit`, { headers: { ...access, "Cache-Control": "no-cache" }, dispatcher: patient }).then((r) => r.json());
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : ""}`);
