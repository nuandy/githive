import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../src/repo-cache";
import { CHALLENGE_WINDOW_MS } from "../src/toolkit/challenges";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Time alone never frees a claim. A claim refused by one whose change waits on its own agent asks that agent whether
// it's still there; any call the agent makes answers, and only an agent that doesn't answer in time loses its claim.
// An agent waiting for review keeps its paths however long it waits.

let server: GitServer;
let work: string;
let now: number;
let keys: Record<string, string> = {};
/** Each agent's untold notices, as the repo's news keeps them. */
let notices: Record<string, Notice[]> = {};
/** Claims sharded from the start (2 deep), or kept in one record. */
let shardDepth: number | undefined;

const DAY = 24 * 60 * 60_000;

const news: Pick<ToolContext, "news" | "notify"> = {
	notify: async (_repo, branch, told) => {
		for (const { agent, notice } of told) (notices[agent] ??= []).push({ ...notice, branch });
	},
	news: async (_repo, _branch, agent) => {
		const untold = notices[agent] ?? [];
		notices[agent] = [];
		return untold;
	},
};
const ctx = (agentKey?: string, extra: Partial<ToolContext> = {}): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
	...news,
	...extra,
	...(agentKey ? { agentKey } : {}),
});
const call = (name: string, args: Record<string, unknown>, as?: string) =>
	callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;
const later = (ms: number) => vi.setSystemTime((now += ms));
const claimA = (agent: string, change = "a") =>
	call("claim", { change, agent, paths: ["src/a/"], intent: change }, agent);

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-abandoned-"));
	keys = {};
	notices = {};
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
		await call("settings", {
			required: 1,
			vetoes: [],
			...(shardDepth ? { shard_depth: shardDepth } : {}),
		});
		for (const agent of ["author", "other", "reviewer"])
			keys[agent] = ((await call("register", { agent })) as { key: string }).key;
	});

	describe("a claim whose agent is quiet", () => {
		it("lasts however long nobody asks, and is freed once its agent doesn't answer when asked", async () => {
			await claimA("author");
			later(DAY);
			const refused = await claimA("other", "b");
			expect(refused).toMatchObject({
				ok: false,
				conflicts: [{ change: "a" }],
				asked: [{ change: "a", holder: "author", answerBy: new Date(now + CHALLENGE_WINDOW_MS).toISOString() }],
			});
			expect(notices.author).toMatchObject([{ kind: "challenged", change: "a", from: { agent: "other" } }]);
			expect(refused.next).toMatch(/^Held by author's a .*Asked author whether it's still there: with no answer by /);
			later(CHALLENGE_WINDOW_MS - 1_000);
			expect(await claimA("other", "b")).toMatchObject({ ok: false, asked: [{ holder: "author" }] });
			// Asked once: the second refusal waits on the same question.
			expect(notices.author).toHaveLength(1);
			later(2_000);
			expect(await claimA("other", "b")).toMatchObject({ ok: true });
			expect(await call("audit", {})).toMatchObject({ violations: [] });
		});

		it("stays its agent's when the agent calls GitHive before the time is up", async () => {
			await claimA("author");
			later(DAY);
			await claimA("other", "b");
			later(60_000);
			const answered = await call("status", { change: "a", agent: "author" }, "author");
			expect(answered.news).toMatchObject([{ kind: "challenged", change: "a", answered: expect.any(String) }]);
			expect(notices.other).toMatchObject([{ kind: "answered", from: { agent: "author", change: "a" } }]);
			later(CHALLENGE_WINDOW_MS + 1_000);
			// Answered, so it isn't freed: it's asked again instead.
			expect(await claimA("other", "b")).toMatchObject({ ok: false, asked: [{ holder: "author" }] });
		});

		it("keeps its paths while it waits for review, however long, and nobody is asked", async () => {
			await claimA("author");
			await pushChange(server.url, work, "author", "a", { "src/a/x.js": "a\n" });
			later(DAY);
			const refused = await claimA("other", "b");
			expect(refused).toMatchObject({ ok: false, conflicts: [{ change: "a" }] });
			expect(refused.asked).toBeUndefined();
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({
				ok: false,
				refused: "a isn't abandoned: it waits for review",
			});
		});

		it("is freed when approved and never merged only once its agent didn't answer", async () => {
			await claimA("author");
			const head = await pushChange(server.url, work, "author", "a", { "src/a/x.js": "a\n" });
			const approve = { commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" };
			await call("vote", approve, "reviewer");
			later(DAY);
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({
				ok: false,
				refused: expect.stringContaining("no one has asked"),
			});
			expect(await claimA("other", "b")).toMatchObject({ ok: false, asked: [{ holder: "author" }] });
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({
				ok: false,
				refused: expect.stringContaining("was asked whether it's still there"),
			});
			later(CHALLENGE_WINDOW_MS + 1_000);
			expect(await call("release", { change: "a", agent: "other", stale: true }, "other")).toMatchObject({ ok: true });
			expect(await call("audit", {})).toMatchObject({ violations: [] });
		});
	});

	describe("abandoned work", () => {
		it("goes to the next agent who asks, once its agent didn't answer, who takes the change over", async () => {
			const piece = { id: "a", title: "a", intent: "do a", paths: ["src/a/"], agent: "author" };
			await call("add_work", piece, "author");
			await claimA("author");
			later(DAY);
			// Quiet, but nobody has asked, so it isn't free to build.
			expect(await call("backlog", { agent: "other" }, "other")).toMatchObject({
				open: [],
				waiting: [{ id: "a", reason: "claimed by author" }],
			});
			await expect(claimA("other")).rejects.toThrow(/author was asked whether it's still working on a/);
			later(CHALLENGE_WINDOW_MS + 1_000);
			expect(await call("backlog", { agent: "other" }, "other")).toMatchObject({
				open: [{ id: "a", abandonedBy: "author" }],
			});
			expect(await claimA("other")).toMatchObject({ ok: true });
			const claims = (await call("claims", {})) as unknown as { change: string; agent: string }[];
			expect(claims.map((claim) => [claim.change, claim.agent])).toEqual([["a", "other"]]);
		});
	});
});

describe("a silent agent's change name", () => {
	it("is taken over only by its owner's agents, while anyone may ask it for paths", async () => {
		const key = await generateStampKey();
		const as = (person: string, agent: string) => {
			const stamper = () => makeStamper(key.privateKey, `${person}/${agent}`);
			return (name: string, args: Record<string, unknown>) =>
				callTool(name, { repo: "p", ...args }, ctx(keys[agent], { identity: person, stamper }));
		};
		await call("settings", { required: 1, vetoes: [] });
		for (const agent of ["ada-1", "ada-2", "bob-1"])
			keys[agent] = ((await call("register", { agent })) as { key: string }).key;
		const claim = (agent: string, change: string) => ({ change, agent, paths: ["src/a/"], intent: change });
		await as("person:ada", "ada-1")("claim", claim("ada-1", "a"));
		later(DAY);
		// Bob's agent may not take Ada's change over, but asking for its paths frees them all the same.
		await expect(as("person:bob", "bob-1")("claim", claim("bob-1", "a"))).rejects.toThrow(/only its owner's agents/);
		expect(await as("person:bob", "bob-1")("claim", claim("bob-1", "b"))).toMatchObject({ ok: false });
		later(CHALLENGE_WINDOW_MS + 1_000);
		await expect(as("person:bob", "bob-1")("claim", claim("bob-1", "a"))).rejects.toThrow(/only its owner's agents/);
		expect(await as("person:ada", "ada-2")("claim", claim("ada-2", "a"))).toMatchObject({ ok: true });
	});
});
