#!/usr/bin/env node
// Work on a GitHive repo as an outside agent, from a shell: call the MCP
// tools, and clone a change's fork with plain git. Tokens and agent keys are
// never printed: tool results have them redacted, a fork's write token goes
// only into that clone's own git config, and an agent key into a file.
//
//   node scripts/mcp-agent.mjs call <tool> '<json args>' [--key-file F]
//   node scripts/mcp-agent.mjs register <repo> <agent> <key-file>      register an agent, key to <key-file>
//   node scripts/mcp-agent.mjs clone <dir> --repo R --change C --key-file F   clone the project, push to your fork (remote "fork"; --full x for all history)
//   node scripts/mcp-agent.mjs auth <dir> (same flags as clone)          fresh write access for an existing clone
//   node scripts/mcp-agent.mjs review-clone <dir> --repo R --change C [--role R] [--key-file F]   a change to review (marks you reviewing it)
//        (the project, with the change's branch from its author's fork as "change", checked out at its pushed head)
//
// --base defaults to the bench Worker. Access credentials come from .dev.vars
// (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET).

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A failure never prints a token: errors carry git's command line, which may hold one.
const redacted = (text) =>
	String(text)
		.replace(/(Bearer |Basic )[^\s"'\]]+/g, "$1<redacted>")
		.replace(/art_v2_[A-Za-z0-9_]+/g, "<redacted>");
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, (err) => {
		console.error(redacted(err instanceof Error ? (err.stack ?? err.message) : err));
		process.exit(1);
	});

const root = new URL("..", import.meta.url).pathname;
const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
	else positional.push(rest[i]);
}
const BASE = flags.base ?? "https://blueprint-bench.nuandy.workers.dev";
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.map((l) => l.match(/^([A-Z_]+)=(.*)$/))
		.filter(Boolean)
		.map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]),
);
const access = {
	"CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID,
	"CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET,
};

async function tool(name, args, keyFile) {
	const key = keyFile ? readFileSync(keyFile, "utf8").trim() : undefined;
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...access, "Content-Type": "application/json", ...(key ? { "X-GitHive-Agent-Key": key } : {}) },
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

const header = (token) => `http.extraHeader=Authorization: Bearer ${token.split("?")[0]}`;

/**
 * Clone with a token (git's own stderr shown, never its command line, which
 * holds the token), tried again a few times: Artifacts answers some shallow
 * fetches with an empty 200 ("fatal: expected 'packfile'"), 3 of 8 in a row
 * on a busy project repo (run 1000-3).
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
			// the agent's fork is shared by its changes and may be behind, so start from the
			// project (origin, read-only) and push to the fork (remote "fork"). Each URL gets its own token.
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
				// No fork remote yet (a fresh clone).
			}
		} else if (command === "clone") {
			// Shallow by default: an agent needs the tip to work on, not the project's whole history (--full for all of it).
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
			// The token lives only in this clone's own config, so plain git push works until it expires (then: auth).
			execFileSync("git", ["-C", dir, "config", "http.extraHeader", `Authorization: Bearer ${token.split("?")[0]}`]);
		}
		console.log(
			`${command === "clone" ? "cloned" : "refreshed"} ${dir}${project ? ' (push your branch to the remote "fork")' : ""}`,
		);
		break;
	}
	case "review-clone": {
		const [dir] = positional;
		const access = await tool(
			"review_access",
			{ repo: flags.repo, change: flags.change, ...(flags.role ? { role: flags.role } : {}) },
			flags["key-file"],
		);
		// Deep enough to diff against the project's branch; read-only tokens, each in this clone's own config.
		cloneWith(access.project.token, ["--depth", "50", "--branch", access.project.branch, access.project.url], dir);
		execFileSync("git", [
			"-C",
			dir,
			"config",
			`http.${access.project.url}.extraHeader`,
			`Authorization: Bearer ${access.project.token.split("?")[0]}`,
		]);
		execFileSync("git", ["-C", dir, "remote", "add", "change", access.url]);
		execFileSync("git", [
			"-C",
			dir,
			"config",
			`http.${access.url}.extraHeader`,
			`Authorization: Bearer ${access.token.split("?")[0]}`,
		]);
		// Shallow, unless Artifacts refuses it: some shallow fetches of a fork's branch fail there ("expected no other
		// sections to be sent after no 'ready'", or "expected shallow list" over protocol v0), where a whole one works.
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
