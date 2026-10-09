import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { AGENT_TURN_IDLE_MS, BUILDING_IDLE_MS } from "../src/toolkit/staleness";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// A claim is freed only when its change waits on its own agent and gets no
// answer: an agent waiting for review keeps its paths however long it waits,
// and an abandoned change's work goes to whoever next asks for work.

let server: GitServer;
let work: string;
let now: number;
const keys: Record<string, string> = {};
/** Claims sharded from the start (2 deep), or kept in one record. */
let shardDepth: number | undefined;

const ctx = (agentKey?: string): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
	...(agentKey ? { agentKey } : {}),
});
const call = (name: string, args: Record<string, unknown>, as?: string) => callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;
const later = (ms: number) => vi.setSystemTime((now += ms));

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-abandoned-"));
	now = Date.parse("2026-10-09T09:00:00.000Z");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
});
afterEach(async () => {
	vi.useRealTimers();
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe.each([
	["kept in one record", undefined],
	["sharded", 2],
])("claims %s", (_mode, depth) => {
	beforeEach(async () => {
		shardDepth = depth;
		await call("start", {
			required: 1,
			vetoes: [],
			...(shardDepth ? { shard_depth: shardDepth } : {}),
		});
		for (const agent of ["author", "other", "reviewer"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
	});

	describe("a claim whose agent is quiet", () => {
		it("is freed after 30 minutes when nothing is pushed", async () => {
			await call("claim", { change: "a", agent: "author", paths: ["src/a/"], intent: "a" }, "author");
			later(BUILDING_IDLE_MS + 60_000);
			expect(await call("claim", { change: "b", agent: "other", paths: ["src/a/"], intent: "b" }, "other")).toMatchObject({ ok: true });
		});

		it("keeps its paths while it waits for review, however long", async () => {
			await call("claim", { change: "a", agent: "author", paths: ["src/a/"], intent: "a" }, "author");
			await pushChange(server.url, work, "author", "a", {
				"src/a/x.js": "a\n",
			});
			later(AGENT_TURN_IDLE_MS * 3);
			expect(await call("claim", { change: "b", agent: "other", paths: ["src/a/"], intent: "b" }, "other")).toMatchObject({ ok: false, conflicts: [{ change: "a" }] });
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({
				ok: false,
				refused: "a isn't abandoned: it waits for review",
			});
		});

		it("is freed 2 hours after it was approved and never merged, not sooner", async () => {
			await call("claim", { change: "a", agent: "author", paths: ["src/a/"], intent: "a" }, "author");
			const head = await pushChange(server.url, work, "author", "a", {
				"src/a/x.js": "a\n",
			});
			await call(
				"vote",
				{
					commit: head,
					reviewer: "reviewer",
					role: "review",
					verdict: "approve",
					evidence: "ok",
				},
				"reviewer",
			);
			later(AGENT_TURN_IDLE_MS - 60_000);
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({
				ok: false,
				refused: expect.stringContaining("approved and not merged"),
			});
			later(2 * 60_000);
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({ ok: true });
		});
	});

	describe("abandoned work", () => {
		it("goes to the next agent who asks, who takes the change over", async () => {
			await call(
				"add_work",
				{
					id: "a",
					title: "a",
					intent: "do a",
					paths: ["src/a/"],
					agent: "author",
				},
				"author",
			);
			await call("claim", { change: "a", agent: "author", paths: ["src/a/"], intent: "a" }, "author");
			// While author is at it, other isn't sent there.
			expect(await call("next", { agent: "other" }, "other")).toMatchObject({
				kind: "wait",
			});
			later(BUILDING_IDLE_MS + 60_000);
			const next = await call("next", { agent: "other" }, "other");
			expect(next).toMatchObject({ kind: "build", work: { id: "a" } });
			expect(String(next.next)).toContain("author started it and abandoned it");
			expect(await call("claim", { change: "a", agent: "other", paths: ["src/a/"], intent: "a" }, "other")).toMatchObject({ ok: true });
			expect(
				(
					(await call("claims", {})) as unknown as {
						change: string;
						agent: string;
					}[]
				).map((c) => [c.change, c.agent]),
			).toEqual([["a", "other"]]);
		});
	});
});
