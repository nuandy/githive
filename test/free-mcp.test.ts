import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { claim, type Registry } from "../src/free/claims";
import { FREE_TOOLS, freeAudit, freeOpenCount, freeSnapshot } from "../src/free/mcp";
import { TOOLS, handleRpc } from "../src/mcp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The coordinator-free MCP tools: stateless, each reads or writes Git and
// reports what Git said. They are served by the main MCP endpoint, beside the
// other tools; driven here over JSON-RPC against a real Git server.

let server: GitServer;
let registered: string[] = [];
let summarized: { repo: string; patch: Record<string, unknown> }[] = [];
let reviewRequests: { repo: string; change: string; roles: string[]; summary?: string }[] = [];
let builds: { repo: string; change: string }[] = [];
const ctx = () => ({
	coordinator: () => {
		throw new Error("not used");
	},
	openRepo: async () => {
		throw new Error("not used");
	},
	free: {
		remote: async () => ({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		register: async (repo: string) => void registered.push(repo),
		summarize: async (repo: string, patch: Record<string, unknown>) => void summarized.push({ repo, patch }),
		startBuilder: async (input: { repo: string; change: string }) => {
			builds.push(input);
			return { change: input.change, builder: `free--${input.repo}--${input.change}` };
		},
		agentStatus: async () => ({ builder: { status: "working", revisions: 0 }, reviewers: [] }),
		requestReview: async (input: { repo: string; change: string; roles: string[]; summary?: string }) => {
			reviewRequests.push(input);
			return { head: "h1", reviewers: input.roles };
		},
	},
});
const call = async (name: string, args: Record<string, unknown>) => {
	const reply = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx() as never)) as {
		result: { content: { text: string }[]; isError?: boolean };
	};
	const text = reply.result.content[0].text;
	return reply.result.isError ? { error: text } : JSON.parse(text);
};

beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

describe("the coordinator-free MCP tools", () => {
	it("are listed by the main MCP endpoint, beside the other tools", async () => {
		const reply = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx() as never)) as { result: { tools: { name: string }[] } };
		expect(reply.result.tools.map((t) => t.name)).toEqual([...TOOLS, ...FREE_TOOLS].map((t) => t.name));
	});

	it("starts the mode, claims, refuses an overlapping claim, and audits a clean repo", async () => {
		// By default one approval; security, who can veto, too for dependency, CI and deploy files.
		expect(await call("free_start", { repo: "project" })).toMatchObject({ repo: "project", policy: { required: 1, vetoes: [], escalate: [{ required: 2, vetoes: ["security"], paths: expect.arrayContaining(["package.json", ".github/"]) }] } });
		expect(await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" })).toMatchObject({ ok: true });
		expect(await call("free_claim", { repo: "project", change: "b-1", agent: "agent-b", paths: ["src/a/x.ts"], intent: "b" })).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1", agent: "agent-a" }],
		});
		expect((await call("free_claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
		expect(await call("free_audit", { repo: "project" })).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("lets free_claim take paths from a claim idle for 30 minutes, releasing it as stale", async () => {
		await call("free_start", { repo: "project" });
		const registry = new GitCasLog<Registry>(async () => ({ url: server.url, token: "unused" }), "project", "refs/notes/blueprint-claims/project");
		await claim(registry, { change: "old-1", agent: "agent-gone", paths: ["src/a/"], intent: "abandoned", now: Date.now() - 31 * 60_000 });
		expect(await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/x.ts"], intent: "a" })).toMatchObject({ ok: true });
		expect((await call("free_claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
		expect(await call("free_audit", { repo: "project" })).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("reads the claims registry once for a call that only reads it", async () => {
		await call("free_start", { repo: "project", shard_depth: 0 });
		await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const before = server.requests.length;
		await call("free_claims", { repo: "project" });
		// One read: where the ref points, then fetch it.
		expect(server.requests.slice(before)).toEqual(["GET refs?service=git-upload-pack", "POST git-upload-pack"]);
	});

	it("reports a missing argument as a tool error", async () => {
		expect(await call("free_claim", { repo: "project" })).toEqual({ error: "change is required" });
	});

	it("reverts a reported commit, after which the audit counts it resolved", async () => {
		await call("free_start", { repo: "project" });
		const work = mkdtempSync(join(tmpdir(), "free-mcp-"));
		try {
			const rogue = await agentClone(server.url, work, "rogue");
			rogue.write("hotfix.txt", "x\n");
			await rogue.run("add", "-A");
			await rogue.run("commit", "--quiet", "-m", "hotfix");
			await rogue.run("push", "--quiet", "origin", "main");
			const bad = await rogue.run("rev-parse", "HEAD");
			expect(await call("free_audit", { repo: "project" })).toMatchObject({ open: 1, violations: [{ commit: bad, rule: "undeclared" }] });
			expect(await call("free_revert", { repo: "project", commit: bad, agent: "agent-c" })).toMatchObject({ ok: true });
			const after = await call("free_audit", { repo: "project" });
			expect(after).toMatchObject({ open: 0, violations: [{ commit: bad, rule: "undeclared" }] });
			expect(after.violations[0].resolvedBy).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 60_000);

	it("notes a repo for the dashboard when the mode starts, and snapshots it", async () => {
		registered = [];
		await call("free_start", { repo: "project", verify: ["npm test"] });
		expect(registered).toEqual(["project"]);
		await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("free_vote", { repo: "project", commit: "h1", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const snapshot = await freeSnapshot(ctx().free, "project");
		expect(snapshot).toMatchObject({
			repo: "project",
			policy: { required: 1, vetoes: [] },
			verify: ["npm test"],
			verified: false,
			// Each claim with where its change stands, and what Blueprint's hosted agents on it are doing.
			claims: [{ change: "a-1", agent: "agent-a", paths: ["src/a/"], head: null, approval: { approved: false, approvals: 0, required: 1 }, hosted: { builder: { status: "working" } } }],
			votes: [{ commit: "h1", reviewer: "rev-1", verdict: "approve" }],
		});
		// The audit replays every record, so it's read on its own.
		expect(snapshot).not.toHaveProperty("audit");
		expect(await freeAudit(ctx().free, "project")).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("keeps the repo's summary for the dashboard: activity on writes, counts when they're read", async () => {
		// Its own repo: activity is noted at most every 10 seconds per repo, and other tests write "project".
		summarized = [];
		await call("free_start", { repo: "summed" });
		await call("free_claim", { repo: "summed", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(summarized.at(-1)).toMatchObject({ repo: "summed", patch: { lastActivity: expect.any(String) } });
		expect(await freeOpenCount(ctx().free, "summed")).toBe(1);
		await freeSnapshot(ctx().free, "summed");
		expect(summarized.at(-1)).toMatchObject({ repo: "summed", patch: { open: 1, needsYou: 0, countedAt: expect.any(String) } });
		await freeAudit(ctx().free, "summed");
		expect(summarized.at(-1)).toEqual({ repo: "summed", patch: { merged: 0, violations: 0 } });
		expect(await freeOpenCount(ctx().free, "elsewhere")).toBeNull();
	});

	it("asks Blueprint's hosted reviewers to review a claimed change, by default a general review and every veto role", async () => {
		reviewRequests = [];
		await call("free_start", { repo: "project", required: 2, vetoes: ["security"] });
		await call("free_claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("free_request_review", { repo: "project", change: "a-1", summary: "adds a" })).toEqual({ head: "h1", reviewers: ["review", "security"] });
		expect(reviewRequests).toEqual([{ repo: "project", change: "a-1", roles: ["review", "security"], summary: "adds a" }]);
		await call("free_request_review", { repo: "project", change: "a-1", roles: ["api"] });
		expect(reviewRequests[1].roles).toEqual(["api"]);
		expect(await call("free_request_review", { repo: "project", change: "nope" })).toEqual({ error: "nope holds no claim: claim the change's paths first" });
	});

	it("claims paths for a new change and starts Blueprint's hosted builder on it", async () => {
		builds = [];
		await call("free_start", { repo: "project" });
		const started = await call("free_build", { repo: "project", intent: "Add a stats page", paths: ["src/stats/"] });
		expect(started.change).toMatch(/^add-a-stats-page-[0-9a-f]{4}$/);
		expect(builds).toEqual([{ repo: "project", change: started.change }]);
		expect((await call("free_claims", { repo: "project" }))[0]).toMatchObject({ change: started.change, agent: "blueprint-builder", paths: ["src/stats/"], intent: "Add a stats page" });
		// Paths someone holds aren't built on.
		expect(await call("free_build", { repo: "project", intent: "More stats", paths: ["src/stats/x.ts"] })).toMatchObject({ ok: false, conflicts: [{ change: started.change }] });
		expect(builds).toHaveLength(1);
	});
});
