#!/usr/bin/env node
// Demonstrates GitHive with forks, live. Each agent registers its own identity,
// works in its change's fork and merges through the toolkit. A rogue agent with
// the same Access identity is refused at every step. It can't act as another
// agent, get another change's fork or push main.
//
//   node scripts/forks-demo.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--repo forks-demo]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed;
// nor are agent keys.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const REPO = args.repo ?? `forks-demo-${Date.now().toString(36)}`;

const vars = Object.fromEntries(
	(await readFile(join(root, ".dev.vars"), "utf8"))
		.split("\n")
		.map((l) => l.match(/^([A-Z_]+)=(.*)$/))
		.filter(Boolean)
		.map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]),
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

/** Calls a tool as the agent holding `key`, if any. Errors come back as { error }. */
async function tool(name, args, key) {
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...headers, ...(key ? { "X-GitHive-Agent-Key": key } : {}) },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: { repo: REPO, ...args } },
		}),
	});
	const reply = await response.json();
	const text = reply.result.content[0].text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
	return reply.result.isError ? { error: text } : JSON.parse(text);
}

const say = (...line) => console.log(...line);
const work = await mkdtemp(join(tmpdir(), "forks-demo-"));

/** A clone of `url` driven with plain git and `token`. */
async function clone(name, { url, token }) {
	const dir = join(work, name);
	const auth = ["-c", `http.extraHeader=Authorization: Bearer ${token.split("?expires=")[0]}`];
	await exec("git", [...auth, "clone", "--quiet", url, dir]);
	const run = async (...a) =>
		(
			await exec("git", ["-C", dir, ...auth, "-c", `user.name=${name}`, "-c", `user.email=${name}@example.com`, ...a])
		).stdout.trim();
	const write = async (path, text) => {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text);
	};
	return { run, write };
}

try {
	say(`repo ${REPO} on ${BASE}`);
	await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: REPO, branch: "main" });
	const started = await tool("settings", { required: 2, vetoes: ["security"], verify: ["test -f index.html"] });
	say(
		"started; policy:",
		JSON.stringify(started.policy),
		"claims sharded",
		started.shardDepth,
		"deep over",
		started.recordsRepos,
		"records repos",
	);

	say("\nagents register their own names, though they share one Access identity");
	const a = await tool("register", { agent: "agent-a" });
	const b = await tool("register", { agent: "agent-b" });
	const rev1 = await tool("register", { agent: "rev-1" });
	const rev2 = await tool("register", { agent: "rev-2" });
	say("  agent-a, agent-b and reviewers rev-1, rev-2 have keys:", Boolean(a.key && b.key && rev1.key && rev2.key));

	say("\nagent-a claims src/a/, and gets write access to its change's own fork");
	say(
		"  claim:",
		JSON.stringify(
			await tool("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" }, a.key),
		).slice(0, 80),
	);
	const forkA = await tool("credentials", { change: "a-1" }, a.key);
	say("  fork:", forkA.url.split("/").pop(), "branch", forkA.branch);
	const cloneA = await clone("agent-a", forkA);
	await cloneA.run("checkout", "--quiet", "-b", "changes/a-1");
	await cloneA.write("src/a/x.txt", "a\n");
	await cloneA.run("add", "-A");
	await cloneA.run("commit", "--quiet", "-m", "a-1: work");
	await cloneA.run("push", "--quiet", "origin", "changes/a-1");
	const aHead = await cloneA.run("rev-parse", "HEAD");
	say("  status:", JSON.stringify((await tool("status", { change: "a-1" }, a.key)).merge));

	say("\nagent-b, sharing the same Access identity, tries to interfere:");
	say(
		"  claim as agent-a without its key:",
		JSON.stringify(await tool("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "mine now" })),
	);
	say("  agent-a's fork with its own key:", JSON.stringify(await tool("credentials", { change: "a-1" }, b.key)));
	const project = await tool("credentials", {}, b.key);
	say("  project credentials:", project.note);
	const cloneB = await clone("agent-b", project);
	await cloneB.write("hotfix.txt", "rogue\n");
	await cloneB.run("add", "-A");
	await cloneB.run("commit", "--quiet", "-m", "hotfix");
	const pushed = await cloneB.run("push", "--quiet", "origin", "main").then(
		() => "PUSHED (should not happen)",
		(err) =>
			`refused: ${
				String(err.stderr || err.message)
					.trim()
					.split("\n")[0]
			}`,
	);
	say("  push to main:", pushed);

	say("\nagent-a approves its own commit: recorded, but an author's approval doesn't count");
	await tool(
		"vote",
		{ commit: aHead, reviewer: "agent-a", role: "tests", verdict: "approve", evidence: "I checked my own work" },
		a.key,
	);
	say("  status:", JSON.stringify((await tool("status", { change: "a-1" }, a.key)).approval));

	say("\nreviewers vote on agent-a's commit; agent-a sees where it stands, and merges");
	await tool(
		"vote",
		{ commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "tests pass" },
		rev1.key,
	);
	say(
		"  status:",
		JSON.stringify(
			(({ head, approval }) => ({ head: head?.slice(0, 8), approval }))(await tool("status", { change: "a-1" }, a.key)),
		),
	);
	await tool(
		"vote",
		{ commit: aHead, reviewer: "rev-2", role: "security", verdict: "approve", evidence: "no secrets" },
		rev2.key,
	);
	const merged = await tool("merge", { change: "a-1", agent: "agent-a" }, a.key);
	say("  merge:", JSON.stringify(merged));
	say(
		"  status after:",
		JSON.stringify(
			(({ claim, released }) => ({
				claim,
				released: released && {
					reason: released.reason,
					mergedAs: released.mergedAs?.slice(0, 8),
					verifiedBy: released.verifiedBy,
				},
			}))(await tool("status", { change: "a-1" }, a.key)),
		),
	);

	const report = await tool("audit", {});
	say(`\nthe audit: ${report.merges} commit(s) on main, ${report.open} open violations`);
	say(
		merged.ok && report.open === 0 && pushed.startsWith("refused")
			? "OK: merged from a fork, rogue refused, audit clean"
			: "NOT OK",
	);
} finally {
	await rm(work, { recursive: true, force: true });
}
