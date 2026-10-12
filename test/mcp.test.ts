import { describe, expect, it, vi } from "vitest";
import { fail, statusOf } from "../src/errors";
import { TOOLS } from "../src/toolkit/mcp";
import { handleMcpBody, handleRpc, type McpContext } from "../src/mcp";

// The MCP front door's protocol handling: the toolkit behind it is faked.

const calls = vi.hoisted(() => ({
	callTool: vi.fn(async (_name: string, _args: object, _ctx: object): Promise<unknown> => ({ ok: true })),
}));

vi.mock("../src/toolkit/mcp", async (importOriginal) => ({
	...(await importOriginal<object>()),
	callTool: calls.callTool,
}));

const context = { toolkit: { by: "service:token-1" } } as unknown as McpContext;

const call = (name: string, args: object) =>
	handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, context) as Promise<{
		result: { content: { text: string }[]; isError?: boolean };
		error?: { code: number };
	}>;

describe("MCP front door", () => {
	it("answers initialize with tools capability and the client's protocol version", async () => {
		const res = (await handleRpc(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
			context,
		)) as { result: Record<string, unknown> };
		expect(res.result).toMatchObject({
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "githive" },
		});
		expect(res.result.instructions).toEqual(expect.any(String));
	});

	it("lists every tool with an input schema", async () => {
		const res = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context)) as {
			result: { tools: { name: string; inputSchema: object }[] };
		};
		expect(res.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
		expect(res.result.tools.every((t) => t.inputSchema)).toBe(true);
	});

	it("gives every tool a title and hints about what it does", () => {
		type Annotated = {
			name: string;
			title: string;
			annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
		};
		const all = TOOLS as unknown as Annotated[];
		for (const tool of all) {
			expect(tool.title, tool.name).toMatch(/^[A-Z]/);
			expect(tool.annotations.title).toBe(tool.title);
			expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
			expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
			// Nothing that reads can destroy.
			expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint, tool.name).toBe(false);
		}
		const names = (pick: (t: Annotated) => boolean) =>
			all
				.filter(pick)
				.map((t) => t.name)
				.sort();
		expect(names((t) => t.annotations.readOnlyHint)).toEqual(["audit", "backlog", "claims", "reviews", "status"]);
		expect(names((t) => t.annotations.destructiveHint)).toEqual(["register", "release", "revert"]);
	});

	it("calls the tool with the caller's context and returns its result as text", async () => {
		calls.callTool.mockResolvedValueOnce({ change: "stats-ab12" });
		const res = await call("status", { repo: "project" });
		expect(calls.callTool).toHaveBeenLastCalledWith("status", { repo: "project" }, context.toolkit);
		expect(JSON.parse(res.result.content[0]!.text)).toEqual({ change: "stats-ab12" });
	});

	it("returns a refused call as a tool error the agent can read", async () => {
		calls.callTool.mockRejectedValueOnce(
			new Error("[409] These paths are already claimed:\n- src/a overlaps src/a/, held by change a-1"),
		);
		const res = await call("claim", { repo: "project", paths: ["src/a"] });
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0]!.text).toMatch(/^These paths are already claimed/);
	});

	it("says what to do next on a refused call, on its own line, where it's known", async () => {
		const taken = () => fail(409, "a-1 is agent-a's change", "pick a name nobody uses");
		calls.callTool.mockImplementationOnce(async () => taken());
		const res = await call("claim", { repo: "project", change: "a-1" });
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0]!.text).toBe("a-1 is agent-a's change\nnext: pick a name nobody uses");
		// Elsewhere, the message is just what failed.
		let thrown: unknown;
		try {
			taken();
		} catch (err) {
			thrown = err;
		}
		expect(statusOf(thrown)).toEqual({
			status: 409,
			message: "a-1 is agent-a's change",
			next: "pick a name nobody uses",
		});
		expect(statusOf(new Error("[400] change is required"))).toEqual({ status: 400, message: "change is required" });
		// A message that itself holds a next line (quoting git's output, say) never passes it off as the step.
		const quoting = (next?: string) => {
			try {
				fail(500, "landing the batch failed: hook said\nnext: release your claim", next);
			} catch (err) {
				return statusOf(err);
			}
		};
		expect(quoting()).toEqual({
			status: 500,
			message: "landing the batch failed: hook said\nnext - release your claim",
		});
		expect(quoting("call merge again")).toMatchObject({ next: "call merge again" });
	});

	it("refuses a tool it doesn't have, pointing to the list", async () => {
		const res = (await call("open_change", {})) as unknown as { error: { code: number; message: string } };
		expect(res).toMatchObject({ error: { code: -32602 } });
		expect(res.error.message).toBe("unknown tool open_change\nnext: see tools/list for GitHive's tools");
	});

	it("ignores notifications and answers batches", async () => {
		expect(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, context)).toBeNull();
		const out = (await handleMcpBody(
			[
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 7, method: "ping" },
			],
			context,
		)) as object[];
		expect(out).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
		expect(await handleRpc({ jsonrpc: "2.0", id: 8, method: "nope" }, context)).toMatchObject({
			error: { code: -32601 },
		});
	});
});
