import { describe, expect, it, vi } from "vitest";
import { FREE_TOOLS } from "../src/free/mcp";
import { handleMcpBody, handleRpc, type McpContext } from "../src/mcp";

// The MCP front door's protocol handling: the toolkit behind it is faked.

const calls = vi.hoisted(() => ({ callFreeTool: vi.fn(async (_name: string, _args: object, _ctx: object): Promise<unknown> => ({ ok: true })) }));

vi.mock("../src/free/mcp", async (importOriginal) => ({ ...(await importOriginal<object>()), callFreeTool: calls.callFreeTool }));

const context = { free: { by: "service:token-1" } } as unknown as McpContext;

const call = (name: string, args: object) =>
	handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, context) as Promise<{ result: { content: { text: string }[]; isError?: boolean }; error?: { code: number } }>;

describe("MCP front door", () => {
	it("answers initialize with tools capability and the client's protocol version", async () => {
		const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, context)) as { result: Record<string, unknown> };
		expect(res.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "blueprint" } });
		expect(res.result.instructions).toEqual(expect.any(String));
	});

	it("lists every tool with an input schema", async () => {
		const res = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context)) as { result: { tools: { name: string; inputSchema: object }[] } };
		expect(res.result.tools.map((t) => t.name)).toEqual(FREE_TOOLS.map((t) => t.name));
		expect(res.result.tools.every((t) => t.inputSchema)).toBe(true);
	});

	it("gives every tool a title and hints about what it does", () => {
		type Annotated = { name: string; title: string; annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean } };
		const all = FREE_TOOLS as unknown as Annotated[];
		for (const tool of all) {
			expect(tool.title, tool.name).toMatch(/^[A-Z]/);
			expect(tool.annotations.title).toBe(tool.title);
			expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
			expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
			// Nothing that reads can destroy.
			expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint, tool.name).toBe(false);
		}
		const names = (pick: (t: Annotated) => boolean) => all.filter(pick).map((t) => t.name).sort();
		expect(names((t) => t.annotations.readOnlyHint)).toEqual(["free_audit", "free_check", "free_claims", "free_next", "free_review_access", "free_status"]);
		expect(names((t) => t.annotations.destructiveHint)).toEqual(["free_register", "free_release", "free_revert"]);
	});

	it("calls the tool with the caller's context and returns its result as text", async () => {
		calls.callFreeTool.mockResolvedValueOnce({ change: "stats-ab12" });
		const res = await call("free_status", { repo: "project" });
		expect(calls.callFreeTool).toHaveBeenLastCalledWith("free_status", { repo: "project" }, context.free);
		expect(JSON.parse(res.result.content[0].text)).toEqual({ change: "stats-ab12" });
	});

	it("returns a refused call as a tool error the agent can read", async () => {
		calls.callFreeTool.mockRejectedValueOnce(new Error("[409] These paths are already claimed:\n- src/a overlaps src/a/, held by change a-1"));
		const res = await call("free_claim", { repo: "project", paths: ["src/a"] });
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toMatch(/^These paths are already claimed/);
	});

	it("refuses a tool it doesn't have", async () => {
		expect(await call("open_change", {})).toMatchObject({ error: { code: -32602 } });
	});

	it("ignores notifications and answers batches", async () => {
		expect(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, context)).toBeNull();
		const out = (await handleMcpBody([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 7, method: "ping" }], context)) as object[];
		expect(out).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
		expect(await handleRpc({ jsonrpc: "2.0", id: 8, method: "nope" }, context)).toMatchObject({ error: { code: -32601 } });
	});
});
