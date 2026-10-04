import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FREE_TOOLS, handleFreeRpc } from "../src/free/mcp";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The coordinator-free MCP tools: stateless, each reads or writes Git and
// reports what Git said. Driven over JSON-RPC against a real Git server.

let server: GitServer;
const ctx = () => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
});
const call = async (name: string, args: Record<string, unknown>) => {
	const reply = (await handleFreeRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx())) as {
		result: { content: { text: string }[]; isError?: boolean };
	};
	const text = reply.result.content[0].text;
	return reply.result.isError ? { error: text } : JSON.parse(text);
};

beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

describe("the coordinator-free MCP tools", () => {
	it("lists its tools", async () => {
		const reply = (await handleFreeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx())) as { result: { tools: { name: string }[] } };
		expect(reply.result.tools.map((t) => t.name)).toEqual(FREE_TOOLS.map((t) => t.name));
	});

	it("starts the mode, claims, refuses an overlapping claim, and audits a clean repo", async () => {
		expect(await call("free_start", { repo: "project" })).toMatchObject({ repo: "project", policy: { required: 2, vetoes: ["security"] } });
		expect(await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" })).toMatchObject({ ok: true });
		expect(await call("free_claim", { repo: "project", change: "b-1", agent: "agent-b", paths: ["src/a/x.ts"], intent: "b" })).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1", agent: "agent-a" }],
		});
		expect((await call("free_claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
		expect(await call("free_audit", { repo: "project" })).toEqual({ merges: 0, violations: [] });
	});

	it("reports a missing argument as a tool error", async () => {
		expect(await call("free_claim", { repo: "project" })).toEqual({ error: "change is required" });
	});
});
