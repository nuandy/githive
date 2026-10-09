import { statusOf } from "./errors";
import { INSTRUCTIONS, TOOLS, callTool, type ToolContext } from "./toolkit/mcp";

// The MCP front door: any agent (Claude Code, Codex, a team's own bots) works
// on a repo through GitHive's tools, with its own fork and plain git. A
// stateless MCP server over HTTP (JSON-RPC 2.0, JSON responses, no sessions),
// behind Cloudflare Access like every other route.

export interface McpContext {
	/** The toolkit for this caller: who it is (as Access verified it) and its agent key. */
	toolkit: ToolContext;
	/**
	 * The repo a tool call names (<owner>/<name>), checked against what the
	 * caller may do: its id, which the toolkit keys everything by, and the name
	 * people use. Without it, a repo is named by its id.
	 */
	resolveRepo?: (repo: string, tool: string, args: Args) => Promise<{ id: string; fullName: string }>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;

interface RpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

const reply = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one JSON-RPC message. Returns null for notifications, which get no response. */
export async function handleRpc(msg: RpcRequest, ctx: McpContext): Promise<object | null> {
	if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "invalid request");
	if (msg.id === undefined) return null;
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
			return reply(msg.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "githive", version: "1.0.0" }, instructions: ctx.toolkit.agent ? `${INSTRUCTIONS}\nYou are signed in to GitHive as the agent ${ctx.toolkit.agent}: what you write is attributed to you, with no key, and you may leave out the agent argument.` : INSTRUCTIONS });
		}
		case "ping":
			return reply(msg.id, {});
		case "tools/list":
			return reply(msg.id, { tools: TOOLS });
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `unknown tool ${String(name)}`);
			// Which tool a request ran, first in its logs: what the runtime logs beside it (a stalled response cancelled, say)
			// is then told apart by tool. The tool and repo only, never who called.
			const from = Date.now();
			const repoArg = typeof msg.params?.arguments === "object" && typeof (msg.params.arguments as Args).repo === "string" ? (msg.params.arguments as Args).repo : "-";
			console.log(`mcp ${name} on ${repoArg}`);
			try {
				let args = (msg.params?.arguments as Args) ?? {};
				const named = typeof args.repo === "string" && ctx.resolveRepo ? await ctx.resolveRepo(args.repo, name, args) : null;
				if (named) args = { ...args, repo: named.id };
				let result = await callTool(name, args, ctx.toolkit);
				if (Date.now() - from >= SLOW_TOOL_MS) console.log(`mcp ${name} took ${Date.now() - from} ms`);
				// Answer with the name the caller used, not the id.
				if (named && result && typeof result === "object" && (result as Args).repo === named.id) result = { ...(result as Args), repo: named.fullName };
				return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				console.log(`mcp ${name} failed after ${Date.now() - from} ms`);
				// Tool failures go back to the agent as results it can act on, not protocol errors.
				const failed = statusOf(err);
				// GitHive's own failures are logged with where they came from: the agent's answer says only what failed.
				if (failed.status >= 500) console.error(`${name} failed: ${err instanceof Error ? err.stack : failed.message}`);
				return reply(msg.id, { content: [{ type: "text", text: failed.message }], isError: true });
			}
		}
		default:
			return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
	}
}

/** A tool call this long is logged with how long it took. */
const SLOW_TOOL_MS = 5_000;

/** Handle a POST body: one message or a batch. Null means respond 202 with no body. */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<object | object[] | null> {
	if (Array.isArray(body)) {
		const out = (await Promise.all(body.map((m) => handleRpc(m as RpcRequest, ctx)))).filter((r): r is object => r !== null);
		return out.length ? out : null;
	}
	return handleRpc(body as RpcRequest, ctx);
}
