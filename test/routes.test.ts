import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// Opening a repo writes the log's first commit to Git; the Git side is faked here.
const genesis = vi.hoisted(() => ({ appended: [] as { parent: string | null; commit: { kind: string; state: { id: string; repo: string; mode?: string } } }[] }));
vi.mock("../src/election-git", () => ({
	GitCasLog: class {
		async append(parent: string | null, commit: never) {
			genesis.appended.push({ parent, commit });
			return "c1";
		}
		async read() {
			return null;
		}
		async tip() {
			return "ledger-tip";
		}
	},
}));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	headOf: vi.fn(async () => "main0"),
}));

// HTTP routes with the Durable Objects faked: what the Worker itself does around Coordinator calls.

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "service", value: "token-1" })),
}));

function fakeEnv() {
	const coordinator = { createOpen: vi.fn() };
	const index = { add: vi.fn(async () => {}), get: vi.fn(async () => null) };
	const env = {
		COORDINATOR: { idFromName: (name: string) => name, get: () => coordinator },
		TASK_INDEX: { getByName: () => index },
	};
	return { env: env as never, coordinator, index };
}

const post = (env: never, path: string, body: unknown) =>
	worker.fetch(new Request(`https://blueprint.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, {} as never);

describe("opening a repo", () => {
	it("starts the task's log in Git, with no coordinator, whether joined over MCP or opened over HTTP", async () => {
		genesis.appended = [];
		const mcp = fakeEnv();
		await post(mcp.env, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_repo", arguments: { repo: "project" } } });
		const http = fakeEnv();
		await post(http.env, "/repos/project/open", {});

		expect(genesis.appended).toHaveLength(2);
		for (const { parent, commit } of genesis.appended) {
			expect(parent).toBeNull();
			expect(commit).toMatchObject({ kind: "genesis", state: { repo: "project", mode: "open" } });
		}
		for (const { coordinator, index } of [mcp, http]) {
			expect(coordinator.createOpen).not.toHaveBeenCalled();
			expect(index.add).toHaveBeenCalledWith(expect.objectContaining({ repo: "project", elected: true }));
		}
		// The same entry either way (opened 1 ms apart, so the time can differ).
		const entry = (calls: unknown[][]) => ({ ...(calls[0][0] as object), createdAt: undefined });
		expect(entry(mcp.index.add.mock.calls)).toEqual(entry(http.index.add.mock.calls));
	});
});

describe("opening a repo already open on the fixed Coordinator", () => {
	it("moves its task to the elected coordinator: the Coordinator hands over its state, which continues the task's record in Git", async () => {
		for (const how of ["http", "mcp"] as const) {
			genesis.appended = [];
			const { env, coordinator, index } = fakeEnv();
			const listed = { id: "t-open", repo: "project", goal: "open", createdAt: "2026-10-01T00:00:00.000Z" };
			const existing = { id: "t-open", repo: "project", mode: "open", goal: "open", createdAt: listed.createdAt, slices: [] };
			index.get.mockResolvedValue(listed as never);
			(coordinator as unknown as { handOver: unknown }).handOver = vi.fn(async () => existing);
			if (how === "http") expect(await (await post(env, "/repos/project/open", {})).json()).toMatchObject({ id: "t-open", mode: "open" });
			else await post(env, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_repo", arguments: { repo: "project" } } });
			expect((coordinator as unknown as { handOver: ReturnType<typeof vi.fn> }).handOver).toHaveBeenCalled();
			expect(coordinator.createOpen).not.toHaveBeenCalled();
			// The elected log starts on top of the Coordinator's ledger, with its state: one record in Git.
			expect(genesis.appended).toEqual([{ parent: "ledger-tip", commit: expect.objectContaining({ kind: "genesis", state: expect.objectContaining({ id: "t-open" }) }) }]);
			expect(index.add).toHaveBeenCalledWith({ ...listed, elected: true });
		}
	});
});

describe("crashing an elected task's leader, for failover tests", () => {
	it("crashes the peer the task index names, for as long as asked", async () => {
		const simulateCrash = vi.fn(async () => undefined);
		const env = {
			TASK_INDEX: { getByName: () => ({ get: async () => ({ id: "t1", repo: "project", elected: true, leader: { name: "t1--a", term: 4 } }) }) },
			PEER: { getByName: (name: string) => (name === "t1--a" ? { simulateCrash } : null) },
		};
		const res = await post(env as never, "/tasks/t1/leader/crash", { forMs: 90_000 });
		expect(await res.json()).toEqual({ crashed: "t1--a", term: 4, forMs: 90_000 });
		expect(simulateCrash).toHaveBeenCalledWith(90_000);
	});

	it("says who leads, as the task index notes it", async () => {
		const env = { TASK_INDEX: { getByName: () => ({ get: async () => ({ id: "t1", repo: "project", elected: true, leader: { name: "t1--b", term: 5 } }) }) } };
		expect(await (await get(env as never, "/tasks/t1/leader")).json()).toEqual({ leader: "t1--b", term: 5 });
	});

	it("says so when nobody leads", async () => {
		const env = { TASK_INDEX: { getByName: () => ({ get: async () => ({ id: "t1", repo: "project", elected: true }) }) } };
		expect((await post(env as never, "/tasks/t1/leader/crash", {})).status).toBe(409);
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
			TASK_INDEX: { getByName: () => ({ get: async () => null }) },
			BUILDER: { getByName: (name: string) => (builders.push(name), { state: async () => ({ status: "working", name }) }) },
			REVIEWER: { getByName: (name: string) => (reviewers.push(name), { state: async () => ({ status: "done", name }) }) },
			ARTIFACTS: {
				list: vi.fn(async ({ cursor }: { cursor?: string }) =>
					cursor
						? { repos: [{ name: "alpha" }, { name: "abcd1234--b" }, { name: "free--alpha--a-1" }, { name: "free-records--alpha--3" }] }
						: { repos: [{ name: "zeta" }, { name: "abcd1234--a" }, { name: "abcd1234--base" }], cursor: "next" },
				),
			},
		};
		return { env: env as never, builders, reviewers, list: env.ARTIFACTS.list };
	}

	it("lists project repos from every page, without task forks or coordinator-free forks and records, sorted", async () => {
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
		const env = { COORDINATOR: { idFromName: (name: string) => name, get: () => coordinator }, TASK_INDEX: { getByName: () => ({ get: async () => null }) } };
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
