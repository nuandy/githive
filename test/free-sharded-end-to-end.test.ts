import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callFreeTool, type FreeContext } from "../src/free/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The coordinator-free tools on a repo whose claims are sharded (the default):
// claims in different parts of the tree go to different refs, overlaps across
// levels are refused, a merge cites the shards it checked, and the audit,
// reading every shard's history, finds nothing wrong.

let server: GitServer;
let work: string;
const ctx: () => FreeContext = () => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
});
const call = async (name: string, args: Record<string, unknown>) => {
	try {
		return (await callFreeTool(name, { repo: "p", ...args }, ctx())) as Record<string, unknown> & { ok?: boolean };
	} catch (err) {
		return { error: statusOf(err).message };
	}
};

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "free-sharded-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("coordinator-free with sharded claims", { timeout: 60_000 }, () => {
	it("claims, refuses across levels, merges citing its shards, and audits clean", async () => {
		expect(await call("free_start", { access: "shared", required: 1, vetoes: [] })).toMatchObject({ shardDepth: 2 });
		expect(await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" })).toMatchObject({ ok: true });
		expect(await call("free_claim", { change: "d-1", agent: "agent-d", paths: ["docs/"], intent: "docs" })).toMatchObject({ ok: true });
		expect(await call("free_claim", { change: "x-1", agent: "agent-x", paths: ["docs/guide/x.md"], intent: "x" })).toMatchObject({ ok: false, conflicts: [{ change: "d-1" }] });
		expect(((await call("free_claims", {})) as unknown as { change: string }[]).map((c) => c.change)).toEqual(["a-1", "d-1"]);

		const head = await pushChange(server.url, work, "agent-a", "a-1", { "src/a/x.ts": "a\n" });
		await call("free_vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const merged = await call("free_merge", { change: "a-1", agent: "agent-a" });
		expect(merged).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=Blueprint-Claims,valueonly)", "main").trim()).toMatch(/^src%2Fa=[0-9a-f]{40}$/);
		expect(await call("free_status", { change: "a-1" })).toMatchObject({ claim: null, released: { reason: "merged", mergedAs: merged.commit } });
		expect(await call("free_audit", {})).toEqual({ merges: 1, open: 0, violations: [] });
	});
});
