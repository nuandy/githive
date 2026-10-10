#!/usr/bin/env node
// Runs GitHive's hosted agents live. The hosted builder makes a change on its
// claim, then the hosted reviewers vote and merge it once approved. Nothing
// coordinates them. Ends with the audit, read from Git alone.
//
//   node scripts/build-demo.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--repo build-demo]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const REPO = args.repo ?? `build-demo-${Date.now().toString(36)}`;

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

async function tool(name, args) {
	const reply = await api("POST", "/mcp", {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: { repo: REPO, ...args } },
	});
	const text = reply.result.content[0].text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const say = (...line) => console.log(new Date().toISOString().slice(11, 19), ...line);

say(`repo ${REPO} on ${BASE}`);
await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: REPO, branch: "main" });
const started = await tool("settings", {
	required: 2,
	vetoes: ["security"],
	verify: ["test -f index.html", "test -f CONTRIBUTING.md"],
});
say("started; policy:", JSON.stringify(started.policy), "checks:", JSON.stringify(started.verify));

const build = await tool("build", {
	intent: "Add a short CONTRIBUTING.md explaining how to fork this repo and open a pull request",
	paths: ["CONTRIBUTING.md"],
});
say("build:", JSON.stringify(build));
const change = build.change;

let snapshot;
for (let waited = 0; waited < 1800; waited += 20) {
	await new Promise((r) => setTimeout(r, 20_000));
	snapshot = await api("GET", `/repos/_/${REPO}`);
	const builder = await api("GET", `/repos/_/${REPO}/builders/${change}`);
	const held = snapshot.claims.find((c) => c.change === change);
	const votes = snapshot.votes.map((v) => `${v.reviewer}:${v.verdict}`).join(" ");
	say(
		`builder ${builder.status} (${builder.pushes} pushes); claim ${held ? "held" : "released"}; merges ${snapshot.audit.merges}; votes ${votes || "none"}`,
	);
	if (builder.status === "failed") {
		say(
			"builder failed:",
			builder.error,
			"\n",
			builder.log
				.slice(-8)
				.map((l) => l.event)
				.join("\n "),
		);
		process.exit(1);
	}
	if (builder.status === "done") {
		// Reviewers are named by the commit they review, the head of the change's branch.
		const { url, token } = await tool("credentials", {});
		const { stdout } = await promisify(execFile)("git", [
			"-c",
			`http.extraHeader=Authorization: Bearer ${token.split("?expires=")[0]}`,
			"ls-remote",
			url,
			`refs/heads/changes/${change}`,
		]);
		const head = stdout.split(/\s/)[0];
		const reviewers = await Promise.all(
			started.policy.vetoes
				.concat("tests")
				.map(async (role) => [role, await api("GET", `/repos/_/${REPO}/reviewers/${change}/${head}/${role}`)]),
		);
		say("  reviewers:", reviewers.map(([role, r]) => `${role} ${r.status}`).join(", "));
		const failed = reviewers.filter(([, r]) => r.status === "failed");
		if (failed.length) {
			for (const [role, r] of failed) say(`reviewer ${role} failed:`, r.error);
			process.exit(1);
		}
	}
	if (!held && snapshot.audit.merges > 0) break;
}

const audited = await tool("audit", {});
say("audit:", JSON.stringify(audited));
say(audited.merges > 0 && audited.open === 0 ? "MERGED by convention, audit clean" : "NOT merged cleanly");
