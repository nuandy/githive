// What the bench and demo scripts share: their flags, the Access service token from .dev.vars, and calls to a
// GitHive Worker's API and MCP tools. The token and agent keys are never printed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../..", import.meta.url).pathname;
export const BENCH_BASE = "https://blueprint-bench.nuandy.workers.dev";

/** The `--name value` pairs on a command line. */
export function parseFlags(argv = process.argv.slice(2)) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1];
	return flags;
}

/** The Access service token from .dev.vars, as request headers. */
export function accessHeaders() {
	const vars = Object.fromEntries(
		readFileSync(join(ROOT, ".dev.vars"), "utf8")
			.split("\n")
			.map((line) => line.match(/^([A-Z_]+)=(.*)$/))
			.filter(Boolean)
			.map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]),
	);
	return {
		"CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID,
		"CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET,
	};
}

/** Calls to one GitHive Worker, with the Access token: its HTTP API, and MCP tools as an agent. */
export function githiveClient(base) {
	const headers = { ...accessHeaders(), "Content-Type": "application/json" };

	async function api(method, path, body, extraHeaders = {}) {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { ...headers, ...extraHeaders },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
		return JSON.parse(text);
	}

	/** A tool's reply text, without control characters, and whether it's an error. As `key`'s agent, if given. */
	async function toolReply(name, args, key) {
		const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
		const reply = await api("POST", "/mcp", call, key ? { "X-GitHive-Agent-Key": key } : {});
		if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
		const text = reply.result.content[0].text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
		return { text, isError: Boolean(reply.result.isError) };
	}

	return { api, toolReply };
}
