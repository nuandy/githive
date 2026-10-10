import { type ArtifactsCalls, countingRequests, describeCounts, type GitRequests } from "./git-http";
import { statusOf } from "./errors";
import { INSTRUCTIONS, TOOLS, callTool, type ToolContext } from "./toolkit/mcp";

// The MCP front door, where any agent works on a repo through GitHive's tools with its own fork and plain git.
// It is a stateless MCP server over HTTP: JSON-RPC 2.0 with JSON responses and no sessions.

export interface McpContext {
	/** The toolkit for this caller, with its verified identity and agent key. */
	toolkit: ToolContext;
	/**
	 * Resolves the <owner>/<name> a tool call names to the repo's id, checking what the caller may do.
	 * Without it, a repo is named by its id.
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
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({
	jsonrpc: "2.0",
	id: id ?? null,
	error: { code, message },
});

/** Handles one JSON-RPC message. Returns null for notifications, which get no response. */
export async function handleRpc(msg: RpcRequest, ctx: McpContext): Promise<object | null> {
	if (!msg || typeof msg !== "object" || typeof msg.method !== "string")
		return rpcError(msg?.id, -32600, "invalid request");
	if (msg.id === undefined) return null;
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			const protocolVersion =
				typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
			return reply(msg.id, {
				protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "githive", version: "1.0.0" },
				instructions: ctx.toolkit.agent
					? `${INSTRUCTIONS}\nYou are signed in to GitHive as the agent ${ctx.toolkit.agent}: what you write is attributed to you, with no key, and you may leave out the agent argument.`
					: INSTRUCTIONS,
			});
		}
		case "ping":
			return reply(msg.id, {});
		case "tools/list":
			return reply(msg.id, { tools: TOOLS });
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
				return rpcError(msg.id, -32602, `unknown tool ${String(name)}`);
			// Log the tool first, so the runtime's own log lines for the request can be told apart by tool.
			// Log the tool and repo only, never the caller.
			const from = Date.now();
			const repoArg =
				typeof msg.params?.arguments === "object" && typeof (msg.params.arguments as Args).repo === "string"
					? (msg.params.arguments as Args).repo
					: "-";
			console.log(`mcp ${name} on ${repoArg}`);
			// Count the call's Git requests and Artifacts calls by repo, to see which tools keep the project repo busy.
			// Artifacts fails a busy repo's requests.
			let counting: ReturnType<typeof countingRequests<unknown>> | undefined;
			let repoId = String(repoArg);
			try {
				let args = (msg.params?.arguments as Args) ?? {};
				const named =
					typeof args.repo === "string" && ctx.resolveRepo ? await ctx.resolveRepo(args.repo, name, args) : null;
				if (named) args = { ...args, repo: named.id };
				repoId = String(args.repo ?? repoArg);
				counting = countingRequests(() => callTool(name, args, ctx.toolkit));
				let result = await counting.done;
				logCounts(name, repoId, counting);
				if (Date.now() - from >= SLOW_TOOL_MS) console.log(`mcp ${name} took ${Date.now() - from} ms`);
				if (named && result && typeof result === "object" && (result as Args).repo === named.id)
					result = { ...(result as Args), repo: named.fullName };
				return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				if (counting) logCounts(name, repoId, counting);
				console.log(`mcp ${name} failed after ${Date.now() - from} ms`);
				// Tool failures go back to the agent as results it can act on, not protocol errors.
				const failed = statusOf(err);
				// Log GitHive's own failures with their stack. The agent's answer says only what failed.
				if (failed.status >= 500) console.error(`${name} failed: ${err instanceof Error ? err.stack : failed.message}`);
				return reply(msg.id, { content: [{ type: "text", text: failed.message }], isError: true });
			}
		}
		default:
			return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
	}
}

/** Logs a call's Git requests and Artifacts calls by kind of repo: the project, its records repos and agents' forks. */
function logCounts(tool: string, repo: string, counting: { requests: GitRequests; artifacts: ArtifactsCalls }) {
	const counts = describeCounts(repo, counting.requests, counting.artifacts);
	if (counts) console.log(`mcp ${tool} ${counts}`);
}

const SLOW_TOOL_MS = 5_000;

/** Handles a POST body holding one message or a batch. Null means respond 202 with no body. */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<object | object[] | null> {
	if (Array.isArray(body)) {
		const out = (await Promise.all(body.map((m) => handleRpc(m as RpcRequest, ctx)))).filter(
			(r): r is object => r !== null,
		);
		return out.length ? out : null;
	}
	return handleRpc(body as RpcRequest, ctx);
}
