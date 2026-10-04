#!/usr/bin/env node
// Coordinator-free mode, live: cooperative agents claim, review and merge by
// convention through the stateless MCP tools; a rogue agent bypasses them with
// plain git. Then the audit, reading only Git, reports what the rogue did.
//
//   node scripts/free-demo.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--repo free-demo]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const REPO = args.repo ?? `free-demo-${Date.now().toString(36)}`;

const vars = Object.fromEntries((await readFile(join(root, ".dev.vars"), "utf8")).split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));
const headers = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET, "Content-Type": "application/json" };

async function api(method, path, body) {
	const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

async function tool(name, args) {
	const reply = await api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: REPO, ...args } } });
	const text = reply.result.content[0].text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const say = (...line) => console.log(...line);
const work = await mkdtemp(join(tmpdir(), "free-demo-"));
let credentials;

/** An agent's clone, driven with plain git and the repo's token. */
async function agentClone(name) {
	const dir = join(work, name);
	const auth = ["-c", `http.extraHeader=Authorization: Bearer ${credentials.token.split("?expires=")[0]}`];
	await exec("git", [...auth, "clone", "--quiet", credentials.url, dir]);
	const run = async (...a) => (await exec("git", ["-C", dir, ...auth, "-c", `user.name=${name}`, "-c", `user.email=${name}@example.com`, ...a])).stdout.trim();
	const write = async (path, text) => {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text);
	};
	return { run, write };
}

async function pushChange(agent, change, files) {
	const clone = await agentClone(`${agent}-${change}`);
	await clone.run("checkout", "--quiet", "-b", `changes/${change}`);
	for (const [path, text] of Object.entries(files)) await clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", `${change}: work`);
	await clone.run("push", "--quiet", "origin", `changes/${change}`);
	return clone.run("rev-parse", "HEAD");
}

try {
	say(`repo ${REPO} on ${BASE}`);
	await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: REPO, branch: "main" });
	const started = await tool("free_start", { required: 2, vetoes: ["security"], verify: ["test -f index.html"] });
	say("started; policy:", JSON.stringify(started.policy), "checks:", JSON.stringify(started.verify));
	credentials = await tool("free_credentials", {});

	say("\nagent-a: claims src/a/, pushes, gets two approvals, merges through the tools");
	say("  claim:", JSON.stringify(await tool("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" })).slice(0, 60));
	const aHead = await pushChange("agent-a", "a-1", { "src/a/x.txt": "a\n" });
	await tool("free_vote", { commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "tests pass" });
	await tool("free_vote", { commit: aHead, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "api unchanged" });
	say("  merge:", JSON.stringify(await tool("free_merge", { change: "a-1", agent: "agent-a" })));

	say("\nagent-d: approved, but its change deletes index.html, which the checks need");
	await tool("free_claim", { change: "d-1", agent: "agent-d", paths: ["index.html"], intent: "d's cleanup" });
	const dClone = await agentClone("agent-d");
	await dClone.run("checkout", "--quiet", "-b", "changes/d-1");
	await dClone.run("rm", "--quiet", "index.html");
	await dClone.run("commit", "--quiet", "-m", "d-1: remove index.html");
	await dClone.run("push", "--quiet", "origin", "changes/d-1");
	const dHead = await dClone.run("rev-parse", "HEAD");
	await tool("free_vote", { commit: dHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "looks fine" });
	await tool("free_vote", { commit: dHead, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "looks fine" });
	const dMerge = await tool("free_merge", { change: "d-1", agent: "agent-d" });
	say("  merge:", JSON.stringify({ ok: dMerge.ok, reasons: dMerge.reasons }));
	await tool("free_release", { change: "d-1", agent: "agent-d", reason: "gave up" });

	say("\nagent-e: its branch started before a-1 merged, and changed the same file");
	await tool("free_claim", { change: "e-1", agent: "agent-e", paths: ["src/a/"], intent: "e's change to a" });
	const eClone = await agentClone("agent-e");
	await eClone.run("checkout", "--quiet", "-b", "changes/e-1", `${aHead}~1`);
	await eClone.write("src/a/x.txt", "e\n");
	await eClone.run("add", "-A");
	await eClone.run("commit", "--quiet", "-m", "e-1: work");
	await eClone.run("push", "--quiet", "origin", "changes/e-1");
	const eHead = await eClone.run("rev-parse", "HEAD");
	await tool("free_vote", { commit: eHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
	await tool("free_vote", { commit: eHead, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "ok" });
	say("  merge:", JSON.stringify(await tool("free_merge", { change: "e-1", agent: "agent-e" })));
	await tool("free_release", { change: "e-1", agent: "agent-e", reason: "will rebase" });

	say("\nagent-c: claims src/c/ and keeps it");
	await tool("free_claim", { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "c's work" });
	say("  claims now:", JSON.stringify((await tool("free_claims", {})).map((c) => `${c.change}:${c.paths.join(",")}`)));

	say("\nagent-b: claims src/b/, but also edits src/c/z.txt, and has one approval of two");
	await tool("free_claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b's work" });
	const bHead = await pushChange("agent-b", "b-1", { "src/b/y.txt": "b\n", "src/c/z.txt": "not b's\n" });
	await tool("free_vote", { commit: bHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "looks fine" });
	say("  the tools refuse to help:", JSON.stringify(await tool("free_merge", { change: "b-1", agent: "agent-b" })));

	say("\nagent-b goes around them with plain git, with trailers saying all is well");
	const rogue = await agentClone("agent-b-rogue");
	const tipOf = async (ref) => (await rogue.run("ls-remote", "origin", ref)).split(/\s+/)[0];
	const claimsTip = await tipOf(`refs/notes/blueprint-claims/${REPO}`);
	const votesTip = await tipOf(`refs/notes/blueprint-votes/${REPO}`);
	await rogue.run("fetch", "--quiet", "origin", "changes/b-1");
	await rogue.run("merge", "--quiet", "--no-ff", "FETCH_HEAD", "-m", `Merge b-1\n\nBlueprint-Change: b-1\nBlueprint-Agent: agent-b\nBlueprint-Claims: ${claimsTip}\nBlueprint-Votes: ${votesTip}`);
	await rogue.run("push", "--quiet", "origin", "main");
	say("  merged by hand:", await rogue.run("rev-parse", "--short", "HEAD"));
	await rogue.write("README.md", "hotfix\n");
	await rogue.run("add", "README.md");
	await rogue.run("commit", "--quiet", "-m", "hotfix");
	await rogue.run("push", "--quiet", "origin", "main");
	say("  and a hotfix straight to main:", await rogue.run("rev-parse", "--short", "HEAD"));

	say("\nthe audit, from Git alone:");
	const report = await tool("free_audit", {});
	say(`  ${report.merges} commits on main since the mode started; ${report.violations.length} violations:`);
	for (const v of report.violations) say(`  - ${v.commit.slice(0, 8)} ${v.author}: ${v.rule}: ${v.detail}`);
} finally {
	await rm(work, { recursive: true, force: true });
}
