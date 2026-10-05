import { describe, expect, it, vi } from "vitest";
import { FREE_TOOLS } from "../src/free/mcp";
import { TOOLS, handleMcpBody, handleRpc, type McpContext } from "../src/mcp";

// The MCP front door's protocol handling and tool mapping, with the Coordinator faked.

function fakeCoordinator() {
	return {
		claims: vi.fn(async () => [{ change: "a-1", owns: ["src/a/"] }]),
		openChange: vi.fn(async (input: { title: string; owns: string[] }) => ({
			change: { id: "stats-ab12", owns: input.owns, leaseUntil: "2026-10-04T10:00:00.000Z" },
			credentials: { slice: "stats-ab12", repo: "t1--stats-ab12", remote: "https://git.test/t1--stats-ab12.git", token: "tok" },
		})),
		extendClaim: vi.fn(),
		abandonChange: vi.fn(),
		recordPush: vi.fn(async () => ({
			task: { slices: [{ id: "stats-ab12", head: "h2", outOfLane: ["src/other.ts"] }] },
			checks: [{ pair: ["other", "stats-ab12"], status: "conflict", files: ["src/x.ts"] }],
			changed: true,
		})),
		startReviewers: vi.fn(async () => ({ head: "h2", reviewers: ["tests"], escalated: false })),
		state: vi.fn(),
		readInbox: vi.fn(async () => []),
		requestLaneChange: vi.fn(),
		answerLaneChange: vi.fn(),
		externalCredentials: vi.fn(),
	};
}

function ctx() {
	const co = fakeCoordinator();
	const openRepo = vi.fn(async (repo: string) => ({ id: "t1", repo, review: { reviewers: ["tests"], required: 1, vetoes: [] }, verify: ["npm test"], leaseMinutes: 30 }));
	const context: McpContext = { coordinator: () => co as never, openRepo, identity: { kind: "service", value: "token-1" } };
	return { co, context, openRepo };
}

const call = (name: string, args: object, context: McpContext) => handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, context) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;

describe("MCP front door", () => {
	it("joins a repo through the shared open-repo path", async () => {
		const { context, openRepo } = ctx();
		const reply = await call("join_repo", { repo: "project" }, context);
		expect(openRepo).toHaveBeenCalledWith("project");
		expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ task_id: "t1", repo: "project", lease_minutes: 30 });
	});

	it("answers initialize with tools capability and the client's protocol version", async () => {
		const { context } = ctx();
		const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, context)) as { result: Record<string, unknown> };
		expect(res.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "blueprint" } });
	});

	it("lists every tool with an input schema", async () => {
		const { context } = ctx();
		const res = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context)) as { result: { tools: { name: string; inputSchema: object }[] } };
		expect(res.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
		expect(res.result.tools.every((t) => t.inputSchema)).toBe(true);
	});

	it("gives every tool, in both modes, a title and hints about what it does", () => {
		type Annotated = { name: string; title: string; annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean } };
		const all = [...TOOLS, ...FREE_TOOLS] as unknown as Annotated[];
		for (const tool of all) {
			expect(tool.title, tool.name).toMatch(/^[A-Z]/);
			expect(tool.annotations.title).toBe(tool.title);
			expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
			expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
			// Nothing that reads can destroy.
			expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint, tool.name).toBe(false);
		}
		const names = (pick: (t: Annotated) => boolean) => all.filter(pick).map((t) => t.name).sort();
		expect(names((t) => t.annotations.readOnlyHint)).toEqual(["change_status", "free_audit", "free_check", "free_claims", "free_status", "list_claims", "read_inbox", "review_queue"]);
		expect(names((t) => t.annotations.destructiveHint)).toEqual(["abandon_change", "free_register", "free_release", "free_revert", "register_agent"]);
	});

	it("opens a change with the caller's identity and returns the fork and lane", async () => {
		const { co, context } = ctx();
		const res = await call("open_change", { task_id: "t1", title: "Stats", intent: "Add stats", paths: ["src/stats/"] }, context);
		const body = JSON.parse(res.result.content[0].text);
		expect(body).toMatchObject({ change_id: "stats-ab12", lane: ["src/stats/"], fork: "https://git.test/t1--stats-ab12.git", token: "tok" });
		expect(co.openChange).toHaveBeenCalledWith({ title: "Stats", intent: "Add stats", owns: ["src/stats/"] }, { kind: "service", value: "token-1" });
	});

	it("reports conflicts and files outside the lane after a push", async () => {
		const { context } = ctx();
		const body = JSON.parse((await call("report_push", { task_id: "t1", change_id: "stats-ab12" }, context)).result.content[0].text);
		expect(body).toMatchObject({ changed: true, outside_lane: ["src/other.ts"], conflicts: [{ with: "other", files: ["src/x.ts"] }] });
		expect(body.advice).toMatch(/Revert the files outside your lane/);
	});

	it("returns a refused claim as a tool error the agent can read", async () => {
		const { co, context } = ctx();
		co.openChange.mockRejectedValueOnce(new Error("[409] These paths are already claimed:\n- src/a overlaps src/a/, held by change a-1"));
		const res = await call("open_change", { task_id: "t1", title: "A", intent: "a", paths: ["src/a"] }, context);
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toMatch(/^These paths are already claimed/);
	});

	it("requires the arguments a tool needs", async () => {
		const { context } = ctx();
		const res = await call("finish_change", { task_id: "t1", change_id: "x" }, context);
		expect(res.result).toMatchObject({ isError: true, content: [{ text: "summary is required" }] });
	});

	it("ignores notifications and answers batches", async () => {
		const { context } = ctx();
		expect(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, context)).toBeNull();
		const out = (await handleMcpBody([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 7, method: "ping" }], context)) as object[];
		expect(out).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
		expect(await handleRpc({ jsonrpc: "2.0", id: 8, method: "nope" }, context)).toMatchObject({ error: { code: -32601 } });
	});
});

describe("outside reviewers over MCP", () => {
	const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
	const reply = async (p: Promise<{ result: { content: { text: string }[]; isError?: boolean } }>) => {
		const { result } = await p;
		return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
	};
	const change = (id: string, overrides: object = {}) => ({
		id,
		title: id,
		status: "building",
		repo: `t1--${id}`,
		owns: [`src/${id}/`],
		touched: [`src/${id}/x.ts`],
		reviewHead: `head-${id}`,
		reviews: [],
		review: { reviewers: ["review"], required: 1, vetoes: [], external: ["review"] },
		...overrides,
	});

	it("registers an agent and returns its key once, keeping only a hash", async () => {
		const { co, context } = ctx();
		Object.assign(co, { registerAgent: vi.fn(async (agent: string) => ({ agent, rotated: false })) });
		const registered = await reply(call("register_agent", { task_id: "t1", agent: "reviewer-1" }, context));
		expect(registered.key).toMatch(/^[0-9a-f]{64}$/);
		expect((co as unknown as { registerAgent: ReturnType<typeof vi.fn> }).registerAgent).toHaveBeenCalledWith("reviewer-1", await sha256(registered.key), undefined, context.identity);
	});

	it("lists changes waiting on an external role, not the caller's own, with read access to each fork", async () => {
		const { co, context } = ctx();
		const key = "k".repeat(64);
		co.state.mockResolvedValue({
			id: "t1",
			branch: "master",
			baseCommit: "base0",
			agents: { "reviewer-1": { keyHash: await sha256(key), at: "" }, "builder-1": { keyHash: "other", at: "" } },
			slices: [change("mine", { authorBy: "agent:reviewer-1" }), change("theirs", { authorBy: "agent:builder-1" }), change("voted", { reviews: [{ reviewer: "review", head: "head-voted", verdict: "approve", summary: "", at: "" }] })],
		} as never);
		const queue = await reply(call("review_queue", { task_id: "t1" }, { ...context, agentKey: key, forkRead: async (repo) => ({ url: `https://git.test/${repo}.git`, token: "read-only" }) }));
		expect(queue.reviews).toEqual([expect.objectContaining({ change_id: "theirs", head: "head-theirs", base: "base0", branch: "master", roles: ["review"], fork: "https://git.test/t1--theirs.git", token: "read-only" })]);
	});

	it("submits a review as the agent whose key it is, and refuses a key it doesn't know", async () => {
		const { co, context } = ctx();
		const key = "k".repeat(64);
		co.state.mockResolvedValue({ id: "t1", agents: { "reviewer-1": { keyHash: await sha256(key), at: "" } }, slices: [] } as never);
		const submitExternalReview = vi.fn(async () => ({ quorum: { status: "approved" }, next: "integrate" }));
		Object.assign(co, { submitExternalReview });
		const args = { task_id: "t1", change_id: "theirs", head: "head-theirs", role: "review", verdict: "approve", summary: "good", evidence: "npm test passes" };
		expect(await reply(call("submit_review", args, { ...context, agentKey: key }))).toEqual({ recorded: true, review: "approved", next: "integrate" });
		expect(submitExternalReview).toHaveBeenCalledWith("theirs", { reviewer: "review", head: "head-theirs", verdict: "approve", summary: "good", evidence: "npm test passes" }, "agent:reviewer-1");
		// Without a key, the Access identity reviews.
		await reply(call("submit_review", args, context));
		expect(submitExternalReview).toHaveBeenLastCalledWith("theirs", expect.anything(), "service:token-1");
		expect(await reply(call("submit_review", args, { ...context, agentKey: "nope" }))).toEqual({ error: "unknown agent key for this task: register_agent first" });
	});
});
