#!/usr/bin/env node
// Work on a Blueprint repo as an outside agent, from a shell: call the MCP
// tools, and clone a change's fork with plain git. Tokens and agent keys are
// never printed: tool results have them redacted, a fork's write token goes
// only into that clone's own git config, and an agent key into a file.
//
//   node scripts/mcp-agent.mjs call <tool> '<json args>' [--key-file F]
//   node scripts/mcp-agent.mjs register <repo> <agent> <key-file>      coordinator-free: register an agent, key to <key-file>
//   node scripts/mcp-agent.mjs clone <dir> --task T --change C          open mode: clone a change's fork
//   node scripts/mcp-agent.mjs clone <dir> --repo R --change C --key-file F   coordinator-free: clone a change's fork
//   node scripts/mcp-agent.mjs auth <dir> (same flags as clone)          fresh write access for an existing clone
//
// --base defaults to the bench Worker. Access credentials come from .dev.vars
// (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET).

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
	else positional.push(rest[i]);
}
const BASE = flags.base ?? "https://blueprint-bench.nuandy.workers.dev";
const vars = Object.fromEntries(readFileSync(join(root, ".dev.vars"), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));
const access = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET };

async function tool(name, args, keyFile) {
	const key = keyFile ? readFileSync(keyFile, "utf8").trim() : undefined;
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...access, "Content-Type": "application/json", ...(key ? { "X-Blueprint-Agent-Key": key } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
	const reply = await response.json();
	if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
	const text = reply.result.content[0].text;
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const redact = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === "token" || k === "key" ? "<redacted>" : v)));

/** A fork's remote and write token, for open mode or coordinator-free. */
async function forkAccess() {
	if (flags.task) {
		const { fork, token } = await tool("refresh_credentials", { task_id: flags.task, change_id: flags.change });
		return { url: fork, token };
	}
	const { url, token } = await tool("free_credentials", { repo: flags.repo, change: flags.change }, flags["key-file"]);
	return { url, token };
}

const header = (token) => `http.extraHeader=Authorization: Bearer ${token.split("?")[0]}`;

switch (command) {
	case "call": {
		const [name, json] = positional;
		console.log(JSON.stringify(redact(await tool(name, json ? JSON.parse(json) : {}, flags["key-file"])), null, 2));
		break;
	}
	case "register": {
		const [repo, agent, keyFile] = positional;
		const { key } = await tool("free_register", { repo, agent });
		writeFileSync(keyFile, key);
		chmodSync(keyFile, 0o600);
		console.log(`registered ${agent} on ${repo}; key in ${keyFile}`);
		break;
	}
	case "clone":
	case "auth": {
		const [dir] = positional;
		const { url, token } = await forkAccess();
		if (command === "clone") execFileSync("git", ["-c", header(token), "clone", "--quiet", url, dir], { stdio: "inherit" });
		// The token lives only in this clone's own config, so plain git push works until it expires (then: auth).
		execFileSync("git", ["-C", dir, "config", "http.extraHeader", `Authorization: Bearer ${token.split("?")[0]}`]);
		console.log(`${command === "clone" ? "cloned" : "refreshed"} ${dir}`);
		break;
	}
	default:
		console.error("usage: call | register | clone | auth (see the top of this file)");
		process.exit(2);
}
