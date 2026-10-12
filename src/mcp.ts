import { type ArtifactsCalls, countingRequests, describeCounts, type GitRequests } from "./git-http";
import { statusOf } from "./errors";
import { describeCaches } from "./sized-cache";
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

function instructionsFor(agent: string | undefined) {
	if (!agent) return INSTRUCTIONS;
	return (
		`${INSTRUCTIONS}\n` +
		`You are signed in to GitHive as the agent ${agent}: what you write is attributed to you, with no key, ` +
		"and you may leave out the agent argument."
	);
}

function negotiateProtocol(requested: unknown) {
	return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

/** The repo a tool call's arguments name, for logging, or "-". */
function repoArgument(params: RpcRequest["params"]) {
	const args = params?.arguments;
	if (typeof args === "object" && typeof (args as Args).repo === "string") return (args as Args).repo;
	return "-";
}

/** Handles one JSON-RPC message. Returns null for notifications, which get no response. */
export async function handleRpc(request: RpcRequest, ctx: McpContext): Promise<object | null> {
	if (!request || typeof request !== "object" || typeof request.method !== "string")
		return rpcError(request?.id, -32600, "invalid request");
	if (request.id === undefined) return null;
	switch (request.method) {
		case "initialize":
			return reply(request.id, {
				protocolVersion: negotiateProtocol(request.params?.protocolVersion),
				capabilities: { tools: {} },
				serverInfo: { name: "githive", version: "1.0.0" },
				instructions: instructionsFor(ctx.toolkit.agent),
			});
		case "ping":
			return reply(request.id, {});
		case "tools/list":
			return reply(request.id, { tools: TOOLS });
		case "tools/call":
			return callToolRpc(request, ctx);
		default:
			return rpcError(request.id, -32601, `method not found: ${request.method}`);
	}
}

async function callToolRpc(request: RpcRequest, ctx: McpContext) {
	const name = request.params?.name;
	if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name))
		return rpcError(request.id, -32602, `unknown tool ${String(name)}\nnext: see tools/list for GitHive's tools`);
	// Log the tool first, so the runtime's own log lines for the request can be told apart by tool.
	// Log the tool and repo only, never the caller.
	const from = Date.now();
	const repoArg = repoArgument(request.params);
	console.log(`mcp ${name} on ${repoArg}`);
	// Count the call's Git requests and Artifacts calls by repo, to see which tools keep the project repo busy.
	// Artifacts fails a busy repo's requests.
	let counting: ReturnType<typeof countingRequests<unknown>> | undefined;
	let repoId = String(repoArg);
	try {
		let args = (request.params?.arguments as Args) ?? {};
		const named =
			typeof args.repo === "string" && ctx.resolveRepo ? await ctx.resolveRepo(args.repo, name, args) : null;
		if (named) args = { ...args, repo: named.id };
		repoId = String(args.repo ?? repoArg);
		counting = countingRequests(() => callTool(name, args, ctx.toolkit));
		let result = await counting.done;
		logCounts(name, repoId, counting);
		if (Date.now() - from >= SLOW_TOOL_MS)
			console.log(`mcp ${name} took ${Date.now() - from} ms; isolate caches: ${describeCaches()}`);
		if (named && result && typeof result === "object" && (result as Args).repo === named.id)
			result = { ...(result as Args), repo: named.fullName };
		return reply(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
	} catch (err) {
		if (counting) logCounts(name, repoId, counting);
		console.log(`mcp ${name} failed after ${Date.now() - from} ms; isolate caches: ${describeCaches()}`);
		// Tool failures go back to the agent as results it can act on, not protocol errors: what failed, then what to
		// do about it where that's known.
		const failed = statusOf(err);
		// Log GitHive's own failures with their stack. The agent's answer says only what failed.
		if (failed.status >= 500) console.error(`${name} failed: ${err instanceof Error ? err.stack : failed.message}`);
		const text = failed.next ? `${failed.message}\nnext: ${failed.next}` : failed.message;
		return reply(request.id, { content: [{ type: "text", text }], isError: true });
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
		const replies = await Promise.all(body.map((message) => handleRpc(message as RpcRequest, ctx)));
		const responses = replies.filter((response): response is object => response !== null);
		return responses.length ? responses : null;
	}
	return handleRpc(body as RpcRequest, ctx);
}
