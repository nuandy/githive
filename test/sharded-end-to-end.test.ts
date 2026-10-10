import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// The tools on a repo whose claims are sharded from the start:
// claims in different parts of the tree go to different refs, overlaps across
// levels are refused, a merge cites the shards it checked, and the audit,
// reading every shard's history, finds nothing wrong.

let server: GitServer;
let work: string;
const ctx: () => ToolContext = () => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
	// Each change's fork, on the same test server: the branches are pushed there.
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
});
const call = async (name: string, args: Record<string, unknown>) => {
	try {
		return (await callTool(name, { repo: "p", ...args }, ctx())) as Record<string, unknown> & { ok?: boolean };
	} catch (err) {
		return { error: statusOf(err).message };
	}
};

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-sharded-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("with sharded claims", { timeout: 60_000 }, () => {
	it("claims, refuses across levels, merges citing its shards, and audits clean", async () => {
		expect(await call("settings", { required: 1, vetoes: [], shard_depth: 2 })).toMatchObject({ shardDepth: 2 });
		expect(await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" })).toMatchObject({ ok: true });
		expect(await call("claim", { change: "d-1", agent: "agent-d", paths: ["docs/"], intent: "docs" })).toMatchObject({ ok: true });
		expect(await call("claim", { change: "x-1", agent: "agent-x", paths: ["docs/guide/x.md"], intent: "x" })).toMatchObject({ ok: false, conflicts: [{ change: "d-1" }] });
		expect(((await call("claims", {})) as unknown as { change: string }[]).map((c) => c.change)).toEqual(["a-1", "d-1"]);

		const head = await pushChange(server.url, work, "agent-a", "a-1", { "src/a/x.ts": "a\n" });
		await call("vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const merged = await call("merge", { change: "a-1", agent: "agent-a" });
		expect(merged).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Claims,valueonly)", "main").trim()).toMatch(/^=[0-9a-f]{40} src%2Fa=[0-9a-f]{40}$/);
		expect(await call("status", { change: "a-1" })).toMatchObject({ claim: null, released: { reason: "merged", mergedAs: merged.commit } });
		expect(await call("audit", {})).toEqual({ merges: 1, open: 0, violations: [] });
	});

	it("spreads claims over records repos, merges, and audits clean from all of them", async () => {
		const created: number[] = [];
		const spread = (): ToolContext => ({
			...ctx(),
			recordsRemote: async (_repo, k) => ({ url: server.repo(`rec-${k}`), token: "unused" }),
			createRecordsRepos: async (_repo, count) => void created.push(count),
		});
		const callSpread = (name: string, args: Record<string, unknown>) => callTool(name, { repo: "p", ...args }, spread()) as Promise<Record<string, unknown>>;
		expect(await callSpread("settings", { required: 1, vetoes: [], shard_depth: 2, records_repos: 4 })).toMatchObject({ shardDepth: 2, recordsRepos: 4 });
		expect(created).toEqual([4]);
		for (const area of ["alpha", "beta", "gamma"]) expect(await callSpread("claim", { change: `${area}-1`, agent: `agent-${area}`, paths: [`${area}/x/`], intent: area })).toMatchObject({ ok: true });
		const head = await pushChange(server.url, work, "agent-alpha", "alpha-1", { "alpha/x/a.ts": "a\n" });
		await callSpread("vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		expect(await callSpread("merge", { change: "alpha-1", agent: "agent-alpha" })).toMatchObject({ ok: true });
		expect(await callSpread("audit", {})).toEqual({ merges: 1, open: 0, violations: [] });
		expect(((await callSpread("claims", {})) as unknown as { change: string }[]).map((c) => c.change)).toEqual(["beta-1", "gamma-1"]);
	});
});
