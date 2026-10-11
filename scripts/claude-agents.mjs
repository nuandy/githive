#!/usr/bin/env node
// Runs real Claude Code agents on a GitHive repo, one headless `claude -p`
// session per agent in the plan, using the CLI's signed-in subscription rather
// than an API key. Each agent has its own GitHive key and does the work for
// real: it claims, edits, pushes, reviews and merges. Set the repo up first
// with the same plan:
//
//   node scripts/swarm.mjs <plan.json> --setup-only
//   node scripts/claude-agents.mjs <plan.json> [--base URL] [--model claude-sonnet-5-5] [--minutes 45] [--only agent-7]
//
// An agent in the plan may have a "brief", which is appended to its prompt, and the plan a "project", which says
// what the repo is (a copy of Express by default). An agent whose key file holds a GitHive agent token (ghv_…)
// signs in with it, as anyone's agent would, and acts under its full name, <handle>/<agent>.
// Each agent works in <plan dir>/agents-work/<agent> and logs its session to
// <agent>.jsonl there. The run ends when every agent stops (when reviews and
// backlog have nothing for it, or at --minutes), then prints what each did, what landed and
// the audit. Tokens and keys are never printed. Each agent's MCP config, which
// holds its key, is readable only by that agent.

import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BENCH_BASE, ROOT, agentHeaders, parseFlags } from "./lib/bench-client.mjs";

const args = process.argv.slice(2);
const planPath = resolve(args[0] ?? "");
const flags = parseFlags(args);
const BASE = flags.base ?? BENCH_BASE;
const model = flags.model ?? "claude-sonnet-5-5";
const minutes = Number(flags.minutes ?? 45);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const here = dirname(planPath);
const at = (path) => (path && !isAbsolute(path) ? join(here, path) : path);

const started = Date.now();
const clock = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
const say = (who, text) => console.log(`${clock()}  ${who.padEnd(10)} ${text}`);
const turnsAndTime = (result) => `${result.num_turns} turns, ${Math.round(result.duration_ms / 1000)}s`;

// --only <agent>[,<agent>] runs just those agents, for example to restart one, and keeps the other folders.
const only = flags.only?.split(",");
/** The plan's full agent count, which each agent is told even with --only. */
const total = plan.agents.length;
if (only) plan.agents = plan.agents.filter((a) => only.includes(a.agent));
const work = join(here, "agents-work");
if (!only) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const keyOf = (spec) => readFileSync(at(spec.keyFile), "utf8").trim();
const project = plan.project ?? "a copy of Express (Node.js)";
/** The git helper talks to the same Worker as the agents. */
const baseFlag = flags.base ? ` --base ${flags.base}` : "";

/** The prompt every agent gets: who it is, the loop, how to use git with GitHive, and its `brief`. */
const prompt = (agent, dir, keyFile, brief, signedIn) =>
	[
		`You are ${agent}, one of ${total} independent AI agents working at the same time on the GitHive repo ` +
			`"${plan.repo}": ${project}. GitHive coordinates you through its MCP tools (server "githive"); read ` +
			`its instructions. Pass repo "${plan.repo}" and agent "${agent}" wherever a tool asks for them. ` +
			(signedIn
				? "You're signed in as that agent already: never call register."
				: "You're registered already, and your key goes with every call: never call register."),
		"",
		"Nobody assigns you work: you look, and choose. Work in a loop:",
		"1. Your own changes first. For each change you hold, call status:",
		"   - landed (or its claim released as merged): it's done.",
		"   - nothing pushed: finish it (below, build).",
		"   - a reviewer asked for changes, or the checks failed: revise it: fix what they asked, commit, push " +
			"the new commit.",
		"   - nothing more needed (approved, or the repo asks for no reviews): call merge. It lands your " +
			"change together with the others ready, after the repo's checks if it has any; it can take a few " +
			"minutes. If it refuses, do what the reasons say.",
		"   - otherwise it's waiting for reviews: leave it.",
		"2. Then reviews: the reviews you may give, in an order of your own so agents spread out: take the " +
			"first that suits you, unless you have a reason not to. Get its code with review-clone (below, which " +
			"also marks you reviewing it), read the diff against the project's branch carefully, and vote on that " +
			"exact commit in the role it names: approve if it's correct and inside its claim, reject with specific " +
			"evidence if not.",
		"3. Then backlog: pieces of work free to build, in an order of your own so agents spread out: take the " +
			"first that suits you, unless you have a reason not to (in a run, four of five agents first picked the " +
			"same piece). Build it: claim its paths (its id as the change), then make the change for real: read " +
			"the surrounding code and tests, and write good code (and tests where it fits). Commit on the branch " +
			"changes/<change>, push it to your fork, then call status. Stay inside your claim. If the claim is " +
			"refused because another agent took it first, pick another.",
		`4. Nothing to do: run \`sleep 30\`, then look again.`,
		"Stop when you've looked three times in a row with nothing to do and none of your changes is still " +
			`open, or when ${minutes} minutes have passed. Then print a short summary of what you did.`,
		"",
		"Git, without ever printing a token (the helper keeps credentials in each clone's own config):",
		`  node ${ROOT}scripts/mcp-agent.mjs clone <dir> --repo ${plan.repo} --change <change> --key-file ${keyFile} ` +
			`--as ${agent}${baseFlag}`,
		`      a clone of the project, with your fork as the remote "fork": push changes/<change> to "fork". ` +
			"Claim first.",
		`  node ${ROOT}scripts/mcp-agent.mjs auth <dir> --repo ${plan.repo} --change <change> --key-file ${keyFile}` +
			baseFlag,
		"      fresh write access for that clone, if a push is refused for authentication.",
		`  node ${ROOT}scripts/mcp-agent.mjs review-clone <dir> --repo ${plan.repo} --change <change> --role ` +
			`<role> --key-file ${keyFile} --as ${agent}${baseFlag}`,
		"      a change to review: the project, with the change checked out at its pushed head " +
			`("origin/<branch>" is what it lands on); marks you reviewing it in that role.`,
		`Make every clone inside ${dir}, a new folder each time. Don't run the test suite as a matter of ` +
			"course: running tests is the repo's checks' job, if it has any, when the change lands. If you do run " +
			`a test, run \`npm install --no-audit --no-fund\` in the clone first. Never rewrite pushed commits; to ` +
			"take in the project's branch, merge it. Don't use GitHive's hosted agents (the build and " +
			`request_review tools).${brief ? `\n\n${brief}` : ""}`,
	].join("\n");

/** The environment without an API key, so the CLI uses its signed-in subscription. */
function withoutApiKey() {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	return env;
}

/** Starts one agent's session with its own MCP config, folder and event log. */
function runAgent(spec) {
	const dir = join(work, spec.agent.replaceAll("/", "--"));
	mkdirSync(dir, { recursive: true });
	const keyFile = at(spec.keyFile);
	const config = join(dir, ".mcp.json");
	writeFileSync(
		config,
		JSON.stringify({
			mcpServers: {
				githive: {
					type: "http",
					url: `${BASE}/mcp`,
					headers: agentHeaders(keyOf(spec)),
				},
			},
		}),
	);
	chmodSync(config, 0o600);
	const events = createWriteStream(join(dir, `${spec.agent}.jsonl`));
	const child = spawn(
		"claude",
		[
			"-p",
			prompt(spec.agent, dir, keyFile, spec.brief, keyOf(spec).startsWith("ghv_")),
			"--model",
			model,
			"--mcp-config",
			config,
			"--strict-mcp-config",
			"--allowedTools",
			"Bash,Read,Edit,Write,Glob,Grep,mcp__githive",
			// Registering again would issue a new key and invalidate the one it uses.
			"--disallowedTools",
			"mcp__githive__register",
			"--permission-mode",
			"acceptEdits",
			"--output-format",
			"stream-json",
			"--verbose",
		],
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
				// Log GitHive calls, which show what the agent is doing.
				if (name.startsWith("githive.")) {
					const details = [name, part.input?.change, part.input?.verdict].filter(Boolean);
					say(spec.agent, details.join(" "));
				}
			}
			if (event.type === "result") summary.result = event;
		}
	});
	child.stderr.on("data", (chunk) => events.write(chunk));
	const limit = setTimeout(
		() => {
			say(spec.agent, `still going after ${minutes + 5} minutes: stopped`);
			child.kill("SIGTERM");
		},
		(minutes + 5) * 60_000,
	);
	return new Promise((done) =>
		child.on("close", (code) => {
			clearTimeout(limit);
			events.end();
			rmSync(config, { force: true });
			const took = summary.result ? `: ${turnsAndTime(summary.result)}` : "";
			say(spec.agent, `done (exit ${code})${took}`);
			done(summary);
		}),
	);
}

for (const spec of plan.agents)
	if (!existsSync(at(spec.keyFile)))
		throw new Error(
			`${spec.agent} has no key (${spec.keyFile}): save its agent token there, or run swarm.mjs ` +
				`${args[0]} --setup-only to register it`,
		);
say(
	"run",
	`${plan.agents.length} Claude Code agents (${model}) on ${plan.repo}, ${plan.backlog.length} pieces in its backlog`,
);
const summaries = await Promise.all(plan.agents.map(runAgent));

console.log("\nWhat each agent did (tool calls):");
for (const s of summaries) {
	const githive = Object.entries(s.tools)
		.filter(([n]) => n.startsWith("githive."))
		.map(([n, c]) => `${n.slice(8)} ${c}`)
		.join(", ");
	const took = s.result ? turnsAndTime(s.result) : "no result";
	const edits = (s.tools.Edit ?? 0) + (s.tools.Write ?? 0);
	console.log(
		`${s.agent.padEnd(10)} ${took}; githive: ${githive || "none"}; bash ${s.tools.Bash ?? 0}, edits ${edits}`,
	);
	if (s.result?.result) console.log(`           ${String(s.result.result).replace(/\s+/g, " ").slice(0, 400)}`);
}
// Read as the first agent: a signed-in agent reads its own repo, and a registered one through Access.
const readHeaders = { ...agentHeaders(keyOf(plan.agents[0])), "Cache-Control": "no-cache" };
delete readHeaders["X-GitHive-Agent-Key"];
const get = (path) => fetch(`${BASE}${path}`, { headers: readHeaders }).then((r) => r.json());
const repoPath = plan.repo.includes("/") ? plan.repo : `_/${plan.repo}`;
const landing = await get(
	`/repos/${repoPath}/landing?branch=${encodeURIComponent(plan.setup?.branch ?? "main")}`,
).catch(() => null);
console.log(
	`\nLanded: ${
		(landing?.recent ?? [])
			.filter((s) => s.how === "landed")
			.map((s) => s.change)
			.join(", ") || "nothing"
	}`,
);
const failed = (landing?.recent ?? []).filter((s) => s.how === "failed");
if (failed.length) console.log(`Put out (checks failed): ${failed.map((s) => s.change).join(", ")}`);
const audit = await get(`/repos/${repoPath}/audit`);
const violations = audit.violations?.length ? `: ${JSON.stringify(audit.violations).slice(0, 400)}` : "";
console.log(`audit: ${audit.merges} merges, ${audit.open} open violations${violations}`);
console.log(`total ${((Date.now() - started) / 1000).toFixed(0)}s`);
