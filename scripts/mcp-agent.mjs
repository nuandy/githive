#!/usr/bin/env node
// Works on a GitHive repo as an outside agent from a shell: calls MCP tools
// and clones a change's fork with plain git. Tokens and agent keys are never
// printed. Tool results are redacted, a fork's write token goes only into that
// clone's git config, and an agent key goes into a file.
//
//   node scripts/mcp-agent.mjs call <tool> '<json args>' [--key-file F]
//   node scripts/mcp-agent.mjs register <repo> <agent> <key-file>      register an agent, key to <key-file>
//   node scripts/mcp-agent.mjs clone <dir> --repo R --change C --key-file F
//        clone the project; push to remote "fork" (--full x for all history)
//   node scripts/mcp-agent.mjs auth <dir> (same flags as clone)          refresh write access for an existing clone
//   node scripts/mcp-agent.mjs review-clone <dir> --repo R --change C [--role R] [--key-file F]
//        check out a change to review: the project, plus the author's fork as remote "change", at the
//        change's pushed head; marks you as reviewing
//
// clone and review-clone take --as <agent>: the clone commits as that agent, not as whoever runs the script.
// --base defaults to the bench Worker. Access credentials come from .dev.vars
// (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET).

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { agentHeaders, BENCH_BASE } from "./lib/bench-client.mjs";

// Errors can carry git's command line, which may hold a token.
const redacted = (text) =>
	String(text)
		.replace(/(Bearer |Basic )[^\s"'\]]+/g, "$1<redacted>")
		.replace(/art_v2_[A-Za-z0-9_]+/g, "<redacted>");
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, (err) => {
		console.error(redacted(err instanceof Error ? (err.stack ?? err.message) : err));
		process.exit(1);
	});

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
	else positional.push(rest[i]);
}
const BASE = flags.base ?? BENCH_BASE;

async function tool(name, args, keyFile) {
	const key = keyFile ? readFileSync(keyFile, "utf8").trim() : undefined;
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...agentHeaders(key), "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
	const reply = await response.json();
	if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
	const text = reply.result.content[0].text;
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const redact = (value) =>
	JSON.parse(JSON.stringify(value, (k, v) => (k === "token" || k === "key" ? "<redacted>" : v)));

/** A fork's remote and write token, with the project to start from. */
async function forkAccess() {
	const { url, token, project } = await tool(
		"credentials",
		{ repo: flags.repo, change: flags.change },
		flags["key-file"],
	);
	return { url, token, project };
}

/** Commits in this clone name the agent (--as), never the global git identity of whoever runs the script. */
function commitAs(dir) {
	if (!flags.as) return;
	const slug = flags.as.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
	execFileSync("git", ["-C", dir, "config", "user.name", flags.as]);
	execFileSync("git", ["-C", dir, "config", "user.email", `${slug}@agents.githive.app`]);
}

const header = (token) => `http.extraHeader=Authorization: Bearer ${token.split("?")[0]}`;

/**
 * Clones with a token, showing git's stderr but never its command line, which
 * holds the token. Retries because Artifacts sometimes answers a shallow fetch
 * with an empty 200 ("fatal: expected 'packfile'") on a busy repo.
 */
function cloneWith(token, args, dir) {
	const CLONE_TRIES = 5;
	for (let attempt = 1; ; attempt++) {
		try {
			execFileSync("git", ["-c", header(token), "clone", "--quiet", ...args, dir], {
				stdio: ["ignore", "inherit", "inherit"],
			});
			return;
		} catch (err) {
			rmSync(dir, { recursive: true, force: true });
			if (attempt === CLONE_TRIES)
				throw new Error(`git clone failed ${CLONE_TRIES} times (exit ${err.status ?? "?"}): see git's message above`);
			execFileSync("sleep", [String(0.5 * attempt + Math.random())]);
		}
	}
}

switch (command) {
	case "call": {
		const [name, json] = positional;
		console.log(JSON.stringify(redact(await tool(name, json ? JSON.parse(json) : {}, flags["key-file"])), null, 2));
		break;
	}
	case "register": {
		const [repo, agent, keyFile] = positional;
		const { key } = await tool("register", { repo, agent });
		writeFileSync(keyFile, key);
		chmodSync(keyFile, 0o600);
		console.log(`registered ${agent} on ${repo}; key in ${keyFile}`);
		break;
	}
	case "clone":
	case "auth": {
		const [dir] = positional;
		const { url, token, project } = await forkAccess();
		const depth = flags.full === undefined ? ["--depth", "1"] : [];
		if (project) {
			// The agent's fork is shared by its changes and may be behind. Start from the
			// read-only project (origin) and push to the fork (remote "fork"). Each URL gets its own token.
			if (command === "clone") cloneWith(project.token, [...depth, "--branch", project.branch, project.url], dir);
			execFileSync("git", [
				"-C",
				dir,
				"config",
				`http.${project.url}.extraHeader`,
				`Authorization: Bearer ${project.token.split("?")[0]}`,
			]);
			try {
				execFileSync("git", ["-C", dir, "remote", "remove", "fork"], { stdio: "ignore" });
			} catch {
				// A fresh clone has no fork remote yet.
			}
		} else if (command === "clone") {
			// Shallow by default, since an agent needs only the tip. --full fetches all history.
			cloneWith(token, [...depth, "--no-single-branch", url], dir);
		}
		if (project) {
			execFileSync("git", ["-C", dir, "remote", "add", "fork", url]);
			execFileSync("git", [
				"-C",
				dir,
				"config",
				`http.${url}.extraHeader`,
				`Authorization: Bearer ${token.split("?")[0]}`,
			]);
		} else {
			// The token lives only in this clone's config, so plain git push works until it expires. Then run auth.
			execFileSync("git", ["-C", dir, "config", "http.extraHeader", `Authorization: Bearer ${token.split("?")[0]}`]);
		}
		if (command === "clone") commitAs(dir);
		console.log(
			`${command === "clone" ? "cloned" : "refreshed"} ${dir}${project ? ' (push your branch to the remote "fork")' : ""}`,
		);
		break;
	}
	case "review-clone": {
		const [dir] = positional;
		const access = await tool(
			"credentials",
			{ repo: flags.repo, change: flags.change, ...(flags.role ? { role: flags.role } : {}) },
			flags["key-file"],
		);
		// Deep enough to diff against the project's branch. Read-only tokens go in this clone's config.
		cloneWith(access.project.token, ["--depth", "50", "--branch", access.project.branch, access.project.url], dir);
		execFileSync("git", [
			"-C",
			dir,
			"config",
			`http.${access.project.url}.extraHeader`,
			`Authorization: Bearer ${access.project.token.split("?")[0]}`,
		]);
		commitAs(dir);
		execFileSync("git", ["-C", dir, "remote", "add", "change", access.url]);
		execFileSync("git", [
			"-C",
			dir,
			"config",
			`http.${access.url}.extraHeader`,
			`Authorization: Bearer ${access.token.split("?")[0]}`,
		]);
		// Try a shallow fetch first. Artifacts rejects some shallow fetches of a fork's branch
		// ("expected shallow list" and similar), so fall back to a full fetch.
		try {
			execFileSync(
				"git",
				[
					"-C",
					dir,
					"fetch",
					"--quiet",
					"--depth",
					"50",
					"change",
					`${access.branch}:refs/remotes/change/${access.branch}`,
				],
				{ stdio: "pipe" },
			);
		} catch {
			execFileSync(
				"git",
				["-C", dir, "fetch", "--quiet", "change", `${access.branch}:refs/remotes/change/${access.branch}`],
				{ stdio: "inherit" },
			);
		}
		execFileSync("git", ["-C", dir, "checkout", "--quiet", access.head]);
		console.log(
			JSON.stringify({
				dir,
				change: access.change,
				author: access.author,
				head: access.head,
				base: `origin/${access.project.branch}`,
			}),
		);
		break;
	}
	default:
		console.error("usage: call | register | clone | auth | review-clone (see the top of this file)");
		process.exit(2);
}
