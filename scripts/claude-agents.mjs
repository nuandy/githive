#!/usr/bin/env node
// Run real Claude Code agents on a GitHive repo: one headless `claude -p`
// session per agent in the plan, on whatever the Claude Code CLI is signed in
// with (a Claude subscription: no API key), all at once. Each is its own
// registered GitHive agent, talks to GitHive over MCP with its own key, and
// does the work for real: asks next, claims, reads and changes the code, runs
// the tests, pushes, reviews others' changes and votes, merges. Set the repo
// up first, with the same plan:
//
//   node scripts/swarm.mjs <plan.json> --setup-only
//   node scripts/claude-agents.mjs <plan.json> [--base URL] [--model claude-sonnet-5-5] [--minutes 45] [--only agent-7]
//
// Each agent works in its own folder (<plan dir>/agents-work/<agent>), and
// its session's events go to <agent>.jsonl there. The run ends when every
// agent has stopped (each stops once next has nothing for it, or at
// --minutes), then prints what each did, what landed, and the audit. Tokens
// and keys are never printed: an agent's MCP config, with its key, is a file
// only it reads.

import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const planPath = resolve(args[0] ?? "");
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const BASE = flag("base") ?? "https://blueprint-bench.nuandy.workers.dev";
const model = flag("model") ?? "claude-sonnet-5-5";
const minutes = Number(flag("minutes") ?? 45);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const here = dirname(planPath);
const at = (path) => (path && !isAbsolute(path) ? join(here, path) : path);
const vars = Object.fromEntries(readFileSync(join(root, ".dev.vars"), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));
const access = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET };

const started = Date.now();
const clock = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
const say = (who, text) => console.log(`${clock()}  ${who.padEnd(10)} ${text}`);

// --only <agent>[,<agent>]: those agents alone (one that stopped early, say), the others' folders left as they are.
const only = flag("only")?.split(",");
/** How many agents the plan runs in all, as each is told (with --only too). */
const total = plan.agents.length;
if (only) plan.agents = plan.agents.filter((a) => only.includes(a.agent));
const work = join(here, "agents-work");
if (!only) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** What every agent is told: who it is, the loop, and how to use git with GitHive. */
const prompt = (agent, dir, keyFile) => `You are ${agent}, one of ${total} independent AI agents working at the same time on the GitHive repo "${plan.repo}": a copy of Express (Node.js). GitHive coordinates you through its MCP tools (server "githive"); read its instructions. Pass repo "${plan.repo}" and agent "${agent}" wherever a tool asks for them. You're registered already, and your key goes with every call: never call register.

Work in a loop:
1. Call next. Do exactly what it says:
   - build: claim the piece's paths (its id as the change), then make the change for real: read the surrounding code and tests, write good code (and tests where it fits), and run the tests. Commit on the branch changes/<change>, push it to your fork, then call check. Stay inside your claim.
   - review: get the change's code, read the diff against the project's branch carefully, run the tests, and vote on that exact commit: approve if it's correct, tested and inside its claim, reject with specific evidence if not.
   - revise: fix what the reviewer or the checks asked for, commit, push the new commit.
   - merge: call merge. It lands your change together with the others ready, after their checks run; it can take a few minutes. If it refuses, do what the reasons say.
   - wait: run \`sleep 30\`, then ask again.
2. Stop when next has said wait three times in a row and none of your changes is still open, or when ${minutes} minutes have passed. Then print a short summary of what you did.

Git, without ever printing a token (the helper keeps credentials in each clone's own config):
  node ${root}scripts/mcp-agent.mjs clone <dir> --repo ${plan.repo} --change <change> --key-file ${keyFile}
      a clone of the project, with your fork as the remote "fork": push changes/<change> to "fork". Claim first.
  node ${root}scripts/mcp-agent.mjs auth <dir> --repo ${plan.repo} --change <change> --key-file ${keyFile}
      fresh write access for that clone, if a push is refused for authentication.
  node ${root}scripts/mcp-agent.mjs review-clone <dir> --repo ${plan.repo} --change <change> --key-file ${keyFile}
      a change to review: the project, with the change checked out at its pushed head ("origin/<branch>" is what it lands on).
Make every clone inside ${dir}, a new folder each time. Run \`npm install --no-audit --no-fund\` in a clone before \`npm test\`. Never rewrite pushed commits; to take in the project's branch, merge it. Don't use GitHive's hosted agents (the build and request_review tools).`;

/** This environment without an API key: the CLI then uses what it's signed in with. */
function withoutApiKey() {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	return env;
}

/** One agent's session: its MCP config (with its key, readable only by it), its folder, its events. */
function runAgent(spec) {
	const dir = join(work, spec.agent);
	mkdirSync(dir, { recursive: true });
	const keyFile = at(spec.keyFile);
	const config = join(dir, ".mcp.json");
	writeFileSync(config, JSON.stringify({ mcpServers: { githive: { type: "http", url: `${BASE}/mcp`, headers: { ...access, "X-GitHive-Agent-Key": readFileSync(keyFile, "utf8").trim() } } } }));
	chmodSync(config, 0o600);
	const events = createWriteStream(join(dir, `${spec.agent}.jsonl`));
	const child = spawn(
		"claude",
		[
			"-p",
			prompt(spec.agent, dir, keyFile),
			"--model",
			model,
			"--mcp-config",
			config,
			"--strict-mcp-config",
			"--allowedTools",
			"Bash,Read,Edit,Write,Glob,Grep,mcp__githive",
			// Registering again would give it a new key, and the one it calls with would stop working.
			"--disallowedTools",
			"mcp__githive__register",
			"--permission-mode",
			"acceptEdits",
			"--output-format",
			"stream-json",
			"--verbose",
		],
		// Its subscription, never an API key.
		{ cwd: dir, env: withoutApiKey(), stdio: ["ignore", "pipe", "pipe"] },
	);
	const summary = { agent: spec.agent, tools: {}, result: null };
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		events.write(chunk);
		buffer += chunk;
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			for (const part of event.message?.content ?? []) {
				if (part.type !== "tool_use") continue;
				const name = part.name.replace(/^mcp__githive__/, "githive.");
				summary.tools[name] = (summary.tools[name] ?? 0) + 1;
				// GitHive calls tell the story: which, and for what.
				if (name.startsWith("githive.")) say(spec.agent, `${name}${part.input?.change ? ` ${part.input.change}` : ""}${part.input?.verdict ? ` ${part.input.verdict}` : ""}`);
			}
			if (event.type === "result") summary.result = event;
		}
	});
	child.stderr.on("data", (chunk) => events.write(chunk));
	const limit = setTimeout(() => {
		say(spec.agent, `still going after ${minutes + 5} minutes: stopped`);
		child.kill("SIGTERM");
	}, (minutes + 5) * 60_000);
	return new Promise((done) =>
		child.on("close", (code) => {
			clearTimeout(limit);
			events.end();
			rmSync(config, { force: true });
			say(spec.agent, `done (exit ${code})${summary.result ? `: ${summary.result.num_turns} turns, ${Math.round(summary.result.duration_ms / 1000)}s` : ""}`);
			done(summary);
		}),
	);
}

for (const spec of plan.agents) if (!existsSync(at(spec.keyFile))) throw new Error(`${spec.agent} isn't registered (no ${spec.keyFile}): run swarm.mjs ${args[0]} --setup-only first`);
say("run", `${plan.agents.length} Claude Code agents (${model}) on ${plan.repo}, ${plan.backlog.length} pieces in its backlog`);
const summaries = await Promise.all(plan.agents.map(runAgent));

console.log("\nWhat each agent did (tool calls):");
for (const s of summaries) {
	const githive = Object.entries(s.tools).filter(([n]) => n.startsWith("githive.")).map(([n, c]) => `${n.slice(8)} ${c}`).join(", ");
	console.log(`${s.agent.padEnd(10)} ${s.result ? `${s.result.num_turns} turns, ${Math.round(s.result.duration_ms / 1000)}s` : "no result"}; githive: ${githive || "none"}; bash ${s.tools.Bash ?? 0}, edits ${(s.tools.Edit ?? 0) + (s.tools.Write ?? 0)}`);
	if (s.result?.result) console.log(`           ${String(s.result.result).replace(/\s+/g, " ").slice(0, 400)}`);
}
const get = (path) => fetch(`${BASE}${path}`, { headers: { ...access, "Cache-Control": "no-cache" } }).then((r) => r.json());
const landing = await get(`/repos/_/${plan.repo}/landing?branch=${encodeURIComponent(plan.setup?.branch ?? "main")}`).catch(() => null);
console.log(`\nLanded: ${(landing?.recent ?? []).filter((s) => s.how === "landed").map((s) => s.change).join(", ") || "nothing"}`);
const failed = (landing?.recent ?? []).filter((s) => s.how === "failed");
if (failed.length) console.log(`Put out (checks failed): ${failed.map((s) => s.change).join(", ")}`);
const audit = await get(`/repos/_/${plan.repo}/audit`);
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : ""}`);
console.log(`total ${((Date.now() - started) / 1000).toFixed(0)}s`);
