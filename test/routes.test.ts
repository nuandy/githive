import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// HTTP routes with the Durable Objects and Artifacts faked: what the Worker itself does.

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "service", value: "token-1" })),
}));
const counts = vi.hoisted(() => ({ openCount: vi.fn(async () => 4) }));
vi.mock("../src/toolkit/mcp", async (importOriginal) => ({ ...(await importOriginal<object>()), openCount: counts.openCount }));

const post = (env: never, path: string, body: unknown) =>
	worker.fetch(new Request(`https://githive.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, {} as never);
const get = (env: never, path: string) => worker.fetch(new Request(`https://githive.test${path}`), env, {} as never);

describe("the dashboard's repos", () => {
	it("lists project repos from every page, without agents' forks and records, sorted", async () => {
		const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
			cursor ? { repos: [{ name: "alpha" }, { name: "fork--alpha--a-1" }, { name: "records--alpha--3" }] } : { repos: [{ name: "zeta" }], cursor: "next" },
		);
		const res = await get({ ARTIFACTS: { list } } as never, "/repos");
		expect(await res.json()).toEqual([
			{ name: "_/alpha", id: "alpha", visibility: "private" },
			{ name: "_/zeta", id: "zeta", visibility: "private" },
		]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("answers from the index, and counts a repo whose counts are older than its last activity in the background", async () => {
		const fresh = { open: 1, countedAt: "2026-10-06T10:00:00.000Z", lastActivity: "2026-10-06T09:00:00.000Z" };
		const index = {
			summaries: vi.fn(async () => ({
				repos: [
					{ repo: "a", since: "2026-10-01T00:00:00.000Z", summary: fresh },
					{ repo: "b", since: "2026-10-01T00:00:00.000Z", summary: { open: 2, countedAt: "2026-10-06T08:00:00.000Z", lastActivity: "2026-10-06T09:00:00.000Z" } },
					{ repo: "c", since: "2026-10-01T00:00:00.000Z", summary: null },
				],
			})),
			summarize: vi.fn(async (_key: string, _counts: object) => {}),
		};
		const waits: Promise<unknown>[] = [];
		const ARTIFACTS = { list: vi.fn(async () => ({ repos: [{ name: "a" }, { name: "b" }, { name: "c" }] })) };
		const response = await worker.fetch(new Request("https://githive.test/summaries"), { REPO_INDEX: { getByName: () => index }, ARTIFACTS } as never, { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never);
		const { repos } = (await response.json()) as { repos: { repo: string; id: string }[] };
		expect(repos.map((r) => [r.repo, r.id])).toEqual([["_/a", "a"], ["_/b", "b"], ["_/c", "c"]]);
		await Promise.all(waits);
		expect(index.summarize.mock.calls.map(([key]) => key).sort()).toEqual(["repo:b", "repo:c"]);
		expect(index.summarize).toHaveBeenCalledWith("repo:b", { open: 4, countedAt: expect.any(String) });
	});
});

describe("the bench's wipe", () => {
	const confirm = { confirm: "delete every repo in the bench namespace" };
	const benchEnv = (names: string[], allowed = true) => {
		const index = { clear: vi.fn(async () => {}) };
		const deleted: string[] = [];
		const env = {
			...(allowed ? { BENCH_WIPE: "allowed" } : {}),
			REPO_INDEX: { getByName: () => index },
			ARTIFACTS: {
				list: vi.fn(async () => ({ repos: names.filter((n) => !deleted.includes(n)).map((name) => ({ name })) })),
				delete: vi.fn(async (name: string) => void deleted.push(name)),
			},
		};
		return { env: env as never, index, deleted };
	};

	it("is refused anywhere it isn't switched on, as on production", async () => {
		const { env, index, deleted } = benchEnv(["project"], false);
		expect((await post(env, "/admin/wipe", confirm)).status).toBe(404);
		expect(index.clear).not.toHaveBeenCalled();
		expect(deleted).toEqual([]);
	});

	it("needs its confirmation, then deletes the namespace's repos and forgets the dashboard's list", async () => {
		const { env, index, deleted } = benchEnv(["project", "t1--a", "fork--docs--c-1"]);
		expect((await post(env, "/admin/wipe", { confirm: "yes" })).status).toBe(400);
		expect(deleted).toEqual([]);
		expect(await (await post(env, "/admin/wipe", confirm)).json()).toEqual({ deleted: 3, failed: [], remaining: 0 });
		expect(deleted).toEqual(["project", "t1--a", "fork--docs--c-1"]);
		expect(index.clear).toHaveBeenCalled();
	});
});
