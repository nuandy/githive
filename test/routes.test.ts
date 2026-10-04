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

const get = (env: never, path: string) => worker.fetch(new Request(`https://blueprint.test${path}`), env, {} as never);

describe("dashboard reads", () => {
	const task = {
		id: "abcd1234",
		review: { reviewers: ["security", "tests"], required: 1, vetoes: [] },
		slices: [
			{ id: "a", reviewHead: "1234567890abcdef" },
			{ id: "b" },
		],
	};
	function readEnv() {
		const builders: string[] = [];
		const reviewers: string[] = [];
		const env = {
			COORDINATOR: { idFromName: (name: string) => name, get: () => ({ state: async () => task }) },
			BUILDER: { getByName: (name: string) => (builders.push(name), { state: async () => ({ status: "working", name }) }) },
			REVIEWER: { getByName: (name: string) => (reviewers.push(name), { state: async () => ({ status: "done", name }) }) },
			ARTIFACTS: {
				list: vi.fn(async ({ cursor }: { cursor?: string }) =>
					cursor
						? { repos: [{ name: "alpha" }, { name: "abcd1234--b" }] }
						: { repos: [{ name: "zeta" }, { name: "abcd1234--a" }, { name: "abcd1234--base" }], cursor: "next" },
				),
			},
		};
		return { env: env as never, builders, reviewers, list: env.ARTIFACTS.list };
	}

	it("lists project repos from every page, without task forks, sorted", async () => {
		const { env, list } = readEnv();
		const res = await get(env, "/repos");
		expect(await res.json()).toEqual([{ name: "alpha" }, { name: "zeta" }]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("shows each slice's builder and the reviewers of its review commit", async () => {
		const { env } = readEnv();
		const body = (await (await get(env, "/tasks/abcd1234/live")).json()) as { agents: unknown[] };
		expect(body.agents).toEqual([
			{
				id: "a",
				builder: { status: "working", name: "abcd1234--a" },
				reviewers: [
					{ role: "security", state: { status: "done", name: "abcd1234--a--review-security--1234567890ab" } },
					{ role: "tests", state: { status: "done", name: "abcd1234--a--review-tests--1234567890ab" } },
				],
			},
			{ id: "b", builder: { status: "working", name: "abcd1234--b" }, reviewers: [] },
		]);
	});

	it("lists a slice's reviewers with the commit they review", async () => {
		const { env } = readEnv();
		expect(await (await get(env, "/tasks/abcd1234/slices/a/reviewers")).json()).toEqual([
			{ role: "security", head: "1234567890abcdef", state: { status: "done", name: "abcd1234--a--review-security--1234567890ab" } },
			{ role: "tests", head: "1234567890abcdef", state: { status: "done", name: "abcd1234--a--review-tests--1234567890ab" } },
		]);
		expect(await (await get(env, "/tasks/abcd1234/slices/b/reviewers")).json()).toEqual([]);
		expect(await (await get(env, "/tasks/abcd1234/slices/a/builder")).json()).toEqual({ status: "working", name: "abcd1234--a" });
	});
});

describe("open-mode change routes", () => {
	function changeEnv() {
		const coordinator = {
			openChange: vi.fn(async () => ({ change: { id: "c1" } })),
			extendClaim: vi.fn(async () => ({ id: "c1" })),
			abandonChange: vi.fn(async () => ({ id: "c1" })),
		};
		const env = { COORDINATOR: { idFromName: (name: string) => name, get: () => coordinator } };
		return { env: env as never, coordinator };
	}

	it("refuses missing arguments with a 400 naming them, as the MCP tools do", async () => {
		const { env, coordinator } = changeEnv();
		const cases: [string, unknown, string][] = [
			["/tasks/abcd1234/changes", {}, "title is required"],
			["/tasks/abcd1234/changes", { title: "T", intent: " " }, "intent is required"],
			["/tasks/abcd1234/changes", { title: "T", intent: "I" }, "owns is required"],
			["/tasks/abcd1234/changes/c1/extend", {}, "owns is required"],
			["/tasks/abcd1234/changes/c1/abandon", { reason: "" }, "reason is required"],
		];
		for (const [path, body, error] of cases) {
			const res = await post(env, path, body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error });
		}
		const notJson = await worker.fetch(new Request("https://blueprint.test/tasks/abcd1234/changes/c1/abandon", { method: "POST", body: "nope" }), env, {} as never);
		expect(notJson.status).toBe(400);
		expect(coordinator.openChange).not.toHaveBeenCalled();
		expect(coordinator.extendClaim).not.toHaveBeenCalled();
		expect(coordinator.abandonChange).not.toHaveBeenCalled();
	});

	it("passes checked arguments through", async () => {
		const { env, coordinator } = changeEnv();
		expect((await post(env, "/tasks/abcd1234/changes", { title: " T ", intent: "I", owns: ["src/a/"], hosted: true })).status).toBe(201);
		expect(coordinator.openChange).toHaveBeenCalledWith({ title: "T", intent: "I", owns: ["src/a/"], hosted: true }, { kind: "service", value: "token-1" });
		await post(env, "/tasks/abcd1234/changes/c1/extend", { owns: ["src/b.ts"] });
		expect(coordinator.extendClaim).toHaveBeenCalledWith("c1", ["src/b.ts"]);
		await post(env, "/tasks/abcd1234/changes/c1/abandon", { reason: "done elsewhere" });
		expect(coordinator.abandonChange).toHaveBeenCalledWith("c1", "done elsewhere", { kind: "service", value: "token-1" });
	});
});
