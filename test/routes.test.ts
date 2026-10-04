import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// HTTP routes with the Durable Objects faked: what the Worker itself does around Coordinator calls.

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "service", value: "token-1" })),
}));

function fakeEnv() {
	const open = { id: "", repo: "", goal: "Open changes", createdAt: "2026-10-04T00:00:00.000Z", review: { reviewers: [], required: 0, vetoes: [] }, verify: [], leaseMinutes: 30 };
	const coordinator = { createOpen: vi.fn(async (id: string, repo: string) => ({ ...open, id, repo })) };
	const index = { add: vi.fn(async () => {}) };
	const env = {
		COORDINATOR: { idFromName: (name: string) => name, get: () => coordinator },
		TASK_INDEX: { getByName: () => index },
	};
	return { env: env as never, coordinator, index };
}

const post = (env: never, path: string, body: unknown) =>
	worker.fetch(new Request(`https://blueprint.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, {} as never);

describe("opening a repo", () => {
	it("lists a repo joined over MCP on the dashboard, like one opened over HTTP", async () => {
		const mcp = fakeEnv();
		await post(mcp.env, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_repo", arguments: { repo: "project" } } });
		const http = fakeEnv();
		await post(http.env, "/repos/project/open", {});

		for (const { coordinator, index } of [mcp, http]) {
			expect(coordinator.createOpen).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{8}$/), "project", {});
			expect(index.add).toHaveBeenCalledWith(expect.objectContaining({ repo: "project", goal: "Open changes" }));
		}
		expect(mcp.index.add.mock.calls[0]).toEqual(http.index.add.mock.calls[0]);
	});
});
