import type { Hono } from "hono";
import type { Principal } from "../auth/principal";
import { resolveRepo, toolLevel } from "../auth/access-control";
import { handleMcpBody } from "../mcp";
import { type AppEnv, toolContext } from "./shared";

// The MCP front door at /mcp, for agents from anywhere. OAuth grants reach the same handler through oauthFor in
// index.ts.

/** One MCP request (stateless JSON-RPC over HTTP) from a caller: Access, an agent token, or an OAuth grant. */
export async function mcpResponse(request: Request, env: Env, principal: Principal | undefined) {
	const body = await request.json().catch(() => null);
	if (body === null)
		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
			{ status: 400 },
		);
	const result = await handleMcpBody(body, {
		toolkit: toolContext(env, principal, request.headers.get("X-GitHive-Agent-Key") ?? undefined),
		resolveRepo: (repo, tool, args) => resolveRepo(env, principal, repo, toolLevel(tool, args)),
	});
	return result === null ? new Response(null, { status: 202 }) : Response.json(result);
}

export function mcpRoutes(app: Hono<AppEnv>) {
	app.post("/mcp", (c) => mcpResponse(c.req.raw, c.env, c.get("principal")));
	app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));
}
