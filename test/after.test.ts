import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// A change can name changes it depends on (after): it merges only once each
// has merged into the branch it lands on, and next hands out backlog work
// only once what it depends on has merged.

let server: GitServer;
let work: string;
const keys: Record<string, string> = {};
const ctx = (agentKey?: string): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async (_repo, branch) => server.git("rev-parse", branch).trim(),
	...(agentKey ? { agentKey } : {}),
});
const call = (name: string, args: Record<string, unknown>, as?: string) => callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;

/** Claim, push and get approved: ready to merge but for what it waits on. */
async function approved(change: string, agent: string, paths: string[], files: Record<string, string>, extra: Record<string, unknown> = {}) {
	await call("claim", { change, agent, paths, intent: change, ...extra }, agent);
	const head = await pushChange(server.url, work, agent, change, files, typeof extra.into === "string" ? `origin/${extra.into}` : undefined);
	await call("vote", { commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" }, "reviewer");
	return head;
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-after-"));
	await call("start", { required: 1, vetoes: [] });
	for (const agent of ["a", "b", "reviewer"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a change that waits on another", () => {
	it("merges only once what it waits on has merged, and says what it waits on meanwhile", async () => {
		await approved("consumer", "b", ["web/"], { "web/x.js": "uses the field\n" }, { after: ["api"] });
		expect(await call("merge", { change: "consumer", agent: "b" }, "b")).toEqual({ ok: false, reasons: ["waits on api, which hasn't merged yet"] });
		expect(await call("status", { change: "consumer" }, "b")).toMatchObject({ waitsOn: ["waits on api, which hasn't merged yet"] });
		await approved("api", "a", ["api/"], { "api/x.js": "the field\n" });
		expect(await call("merge", { change: "api", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(await call("merge", { change: "consumer", agent: "b" }, "b")).toMatchObject({ ok: true });
		expect(await call("audit", {})).toMatchObject({ merges: 2, open: 0 });
	});

	it("doesn't count what merged into another branch", async () => {
		await approved("api", "a", ["api/"], { "api/x.js": "the field\n" }, { into: "feature/f", from: "main" });
		await call("merge", { change: "api", agent: "a" }, "a");
		await approved("consumer", "b", ["web/"], { "web/x.js": "uses the field\n" }, { after: ["api"] });
		expect(await call("merge", { change: "consumer", agent: "b" }, "b")).toEqual({ ok: false, reasons: ["waits on api, which merged into feature/f, not main"] });
	});

	it("can't close a loop: every change in it would wait forever", async () => {
		await call("claim", { change: "x", agent: "a", paths: ["x/"], intent: "x", after: ["y"] }, "a");
		await expect(call("claim", { change: "y", agent: "b", paths: ["y/"], intent: "y", after: ["x"] }, "b")).rejects.toThrow(/y would wait on itself: y waits on x waits on y/);
		await expect(call("claim", { change: "z", agent: "b", paths: ["z/"], intent: "z", after: ["z"] }, "b")).rejects.toThrow(/can't wait on itself/);
	});
});

describe("backlog work that waits on other pieces", () => {
	it("is free to build only once they've merged, with after to claim it with", async () => {
		await call("add_work", { id: "api", title: "api", intent: "the field", paths: ["api/"], agent: "a" }, "a");
		await call("add_work", { id: "consumer", title: "consumer", intent: "use the field", paths: ["web/"], after: ["api"], agent: "a" }, "a");
		expect(await call("backlog", { agent: "b" }, "b")).toMatchObject({ open: [{ id: "api" }], waiting: [{ id: "consumer", reason: "waits on api to merge" }] });
		await approved("api", "a", ["api/"], { "api/x.js": "the field\n" });
		// Claimed, not merged: consumer still waits.
		expect(await call("backlog", { agent: "b" }, "b")).toMatchObject({ open: [], waiting: [{ id: "api", reason: "claimed by a" }, { id: "consumer" }] });
		await call("merge", { change: "api", agent: "a" }, "a");
		expect(await call("backlog", { agent: "b" }, "b")).toMatchObject({ open: [{ id: "consumer", after: ["api"] }], waiting: [] });
	});
});
