#!/usr/bin/env node
// Seeds a demo repo for the dashboard with changes in every state a person
// would see on a pull request list. Agents with their own keys claim, push,
// vote and merge through the toolkit, without model calls.
//
//   node scripts/seed-demo.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--repo demo-<time>]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed;
// nor are agent keys.

import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const REPO = args.repo ?? `demo-${Date.now().toString(36)}`;

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

/** Calls a tool as the agent holding `key`, if any. */
async function tool(name, toolArgs, key) {
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...headers, ...(key ? { "X-GitHive-Agent-Key": key } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: toolArgs } }),
	});
	if (!response.ok) throw new Error(`${name}: ${response.status} ${(await response.text()).slice(0, 300)}`);
	const reply = await response.json();
	const text = reply.result.content[0].text;
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const say = (...line) => console.log(...line);
const work = await mkdtemp(join(tmpdir(), "seed-demo-"));

const write = (dir, path, text) => {
	fs.mkdirSync(join(dir, path, ".."), { recursive: true });
	fs.writeFileSync(join(dir, path), text);
	return { [path]: "add" };
};

/** Claims, pushes the change to its fork and returns its head. */
async function seedChange(repo, agent, { change, intent, paths, edit }) {
	await tool("claim", { repo, change, agent: agent.name, paths, intent }, agent.key);
	const fork = await tool("credentials", { repo, change }, agent.key);
	const dir = join(work, `${repo}-${change}`);
	const onAuth = () => ({ username: "x", password: fork.token.replace(/\?.*$/, "") });
	await git.clone({ fs, http, dir, url: fork.url, depth: 1, singleBranch: true, onAuth });
	for (const [path, action] of Object.entries(await edit(dir)))
		await (action === "remove" ? git.remove({ fs, dir, filepath: path }) : git.add({ fs, dir, filepath: path }));
	const head = await git.commit({
		fs,
		dir,
		message: intent,
		author: { name: agent.name, email: `${agent.name}@example.com` },
	});
	await git.push({ fs, http, dir, url: fork.url, ref: "main", remoteRef: `refs/heads/changes/${change}`, onAuth });
	await tool("check", { repo, change }, agent.key);
	return head;
}

async function seedRepo() {
	const repo = REPO;
	say(`\n${repo} on ${BASE}`);
	await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: repo, branch: "main" });
	await tool("settings", { repo, required: 2, vetoes: ["security"], verify: ["test -f index.html"] });
	const agents = {};
	for (const name of [
		"docs-agent",
		"style-agent",
		"readme-agent",
		"theme-agent",
		"layout-agent",
		"tests-reviewer",
		"security-reviewer",
	])
		agents[name] = { name, key: (await tool("register", { repo, agent: name })).key };
	const vote = (commit, reviewer, role, verdict, evidence) =>
		tool("vote", { repo, commit, reviewer, role, verdict, evidence }, agents[reviewer].key);

	// Merged: both reviewers approve, the checks pass, and the toolkit merges it.
	const contributing = await seedChange(repo, agents["docs-agent"], {
		change: "contributing-guide",
		intent: "Add a contributing guide explaining how to fork and open a pull request",
		paths: ["CONTRIBUTING.md"],
		edit: (dir) =>
			write(
				dir,
				"CONTRIBUTING.md",
				"# Contributing\n" +
					"\n" +
					"1. Fork this repository.\n" +
					"2. Make your change on a branch.\n" +
					"3. Open a pull request describing what you changed and why.\n",
			),
	});
	await vote(
		contributing,
		"tests-reviewer",
		"tests",
		"approve",
		"CONTRIBUTING.md renders; no code changed, index.html still present.",
	);
	await vote(
		contributing,
		"security-reviewer",
		"security",
		"approve",
		"Documentation only; no scripts, links or secrets.",
	);
	const merged = await tool(
		"merge",
		{ repo, change: "contributing-guide", agent: "docs-agent" },
		agents["docs-agent"].key,
	);
	say(`  contributing-guide: ${merged.ok ? "merged" : JSON.stringify(merged)}`);

	// Changes requested: the security reviewer vetoes it.
	const title = await seedChange(repo, agents["style-agent"], {
		change: "center-title",
		intent: "Center the page title",
		paths: ["styles.css"],
		edit: (dir) =>
			write(
				dir,
				"styles.css",
				"@import url(http://example.com/fonts.css);\n" +
					"\n" +
					"* {\n" +
					"  margin: 0;\n" +
					"  padding: 0;\n" +
					"}\n" +
					"\n" +
					"h1 {\n" +
					"  text-align: center;\n" +
					"}\n",
			),
	});
	await vote(
		title,
		"tests-reviewer",
		"tests",
		"approve",
		"The heading is centered; index.html still loads styles.css.",
	);
	await vote(
		title,
		"security-reviewer",
		"security",
		"reject",
		"styles.css now imports a stylesheet over plain http from example.com, a third-party host; drop " +
			"the import or serve the font locally.",
	);
	say("  center-title: changes requested");

	// In review: one approval of the two required.
	const readme = await seedChange(repo, agents["readme-agent"], {
		change: "clarify-readme",
		intent: "Say what the repo is for in the README's first line",
		paths: ["README.md"],
		edit: (dir) =>
			write(
				dir,
				"README.md",
				"### Well hello there!\n" +
					"\n" +
					"This repository is meant to provide an example for *forking* a repository on GitHub.\n",
			),
	});
	await vote(readme, "tests-reviewer", "tests", "approve", "README only; nothing to run.");
	say("  clarify-readme: in review, one approval of two");

	// Working: claimed and pushed, not yet reviewed.
	await seedChange(repo, agents["theme-agent"], {
		change: "dark-mode",
		intent: "Respect the reader's dark-mode preference",
		paths: ["dark.css"],
		edit: (dir) =>
			write(
				dir,
				"dark.css",
				"@media (prefers-color-scheme: dark) {\n" + "  body { background: #111; color: #eee; }\n" + "}\n",
			),
	});
	say("  dark-mode: in progress");

	// Abandoned: claimed, then released.
	await tool(
		"claim",
		{ repo, change: "new-layout", agent: "layout-agent", paths: ["layout/"], intent: "Try a new page layout" },
		agents["layout-agent"].key,
	);
	await tool(
		"release",
		{ repo, change: "new-layout", agent: "layout-agent", reason: "Not needed after all." },
		agents["layout-agent"].key,
	);
	say("  new-layout: released");

	const audit = await tool("audit", { repo });
	say(`  audit: ${audit.merges} merge(s) on main, ${audit.open} open violations`);
}

try {
	await seedRepo();
} finally {
	await rm(work, { recursive: true, force: true });
}
