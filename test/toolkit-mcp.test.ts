import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claim, type Registry } from "../src/toolkit/claims";
import { TOOLS, repoAudit, openCount, repoSnapshot } from "../src/toolkit/mcp";
import { handleRpc } from "../src/mcp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// GitHive's MCP tools: stateless, each reads or writes Git and
// reports what Git said. Driven here over JSON-RPC against a real Git server.

let server: GitServer;
let registered: string[] = [];
let summarized: { repo: string; patch: Record<string, unknown> }[] = [];
let pinged: string[] = [];
let reviewRequests: { repo: string; change: string; roles: string[]; summary?: string }[] = [];
let builds: { repo: string; change: string }[] = [];
const ctx = () => ({
	toolkit: {
		remote: async () => ({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		register: async (repo: string) => void registered.push(repo),
		summarize: async (repo: string, patch: Record<string, unknown>) => void summarized.push({ repo, patch }),
		ping: async (repo: string) => void pinged.push(repo),
		startBuilder: async (input: { repo: string; change: string }) => {
			builds.push(input);
			return { change: input.change, builder: `fork--${input.repo}--${input.change}` };
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

describe("GitHive's MCP tools", () => {
	it("are listed by the main MCP endpoint, beside the other tools", async () => {
		const reply = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx() as never)) as { result: { tools: { name: string }[] } };
		expect(reply.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
	});

	it("starts the mode, claims, refuses an overlapping claim, and audits a clean repo", async () => {
		// By default one approval; security, who can veto, too for dependency, CI and deploy files.
		expect(await call("start", { repo: "project" })).toMatchObject({ repo: "project", policy: { required: 1, vetoes: [], escalate: [{ required: 2, vetoes: ["security"], paths: expect.arrayContaining(["package.json", ".github/"]) }] } });
		expect(await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" })).toMatchObject({ ok: true });
		expect(await call("claim", { repo: "project", change: "b-1", agent: "agent-b", paths: ["src/a/x.ts"], intent: "b" })).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1", agent: "agent-a" }],
		});
		expect((await call("claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
		expect(await call("audit", { repo: "project" })).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("changes a started repo's policy or checks with settings, keeping what it leaves out, and says so in the records", async () => {
		expect(await call("settings", { repo: "project", verify: ["npm test"] })).toMatchObject({ error: expect.stringContaining("hasn't started") });
		await call("start", { repo: "project", required: 2, vetoes: ["security"], verify: ["npm test"] });
		// Starting again changes nothing: settings does.
		expect(await call("start", { repo: "project", verify: ["npm install", "npm test"] })).toMatchObject({ verify: ["npm test"] });
		expect(await call("settings", { repo: "project" })).toMatchObject({ error: expect.stringContaining("name what to change") });
		expect(await call("settings", { repo: "project", verify: ["npm install", "npm test"] })).toMatchObject({ policy: { required: 2, vetoes: ["security"] }, verify: ["npm install", "npm test"] });
		pinged = [];
		expect(await call("settings", { repo: "project", required: 1 })).toMatchObject({ policy: { required: 1, vetoes: ["security"] }, verify: ["npm install", "npm test"] });
		// The dashboard's views of the repo rebuild with the new settings.
		expect(pinged).toEqual(["project"]);
		expect(await call("settings", { repo: "project", verify: "npm test" })).toMatchObject({ error: expect.stringContaining("verify is a list") });
		const log = server.git("log", "--format=%B", "refs/notes/githive-claims/project");
		expect(log).toContain("Settings: the checks (npm install; npm test) changed");
		expect(log).toContain("Settings: the review policy changed");
	});

	it("answers the claims tool from the kept copy when the context keeps one", async () => {
		await call("start", { repo: "project" });
		await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const kept = { claims: [{ change: "kept-1", agent: "agent-k", paths: ["src/k/"], intent: "k", since: "", active: "" }], merged: [] };
		const reply = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claims", arguments: { repo: "project" } } }, { toolkit: { ...ctx().toolkit, keptClaims: async () => kept } } as never)) as { result: { content: { text: string }[] } };
		expect(JSON.parse(reply.result.content[0].text).map((c: { change: string }) => c.change)).toEqual(["kept-1"]);
		// Without one, the claims are read from Git.
		expect((await call("claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
	});

	it("lets claim take paths from a claim idle for 30 minutes, releasing it as stale", async () => {
		await call("start", { repo: "project" });
		const registry = new GitCasLog<Registry>(async () => ({ url: server.url, token: "unused" }), "project", "refs/notes/githive-claims/project");
		await claim(registry, { change: "old-1", agent: "agent-gone", paths: ["src/a/"], intent: "abandoned", now: Date.now() - 31 * 60_000 });
		expect(await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/x.ts"], intent: "a" })).toMatchObject({ ok: true });
		expect((await call("claims", { repo: "project" })).map((c: { change: string }) => c.change)).toEqual(["a-1"]);
		expect(await call("audit", { repo: "project" })).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("reads the claims registry once for a call that only reads it", async () => {
		await call("start", { repo: "project", shard_depth: 0 });
		await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const before = server.requests.length;
		await call("claims", { repo: "project" });
		// One read: where the ref points, then fetch it.
		expect(server.requests.slice(before)).toEqual(["GET refs?service=git-upload-pack", "POST git-upload-pack"]);
	});

	it("reports a missing argument as a tool error", async () => {
		expect(await call("claim", { repo: "project" })).toEqual({ error: "change is required" });
	});

	it("reverts a reported commit, after which the audit counts it resolved", async () => {
		await call("start", { repo: "project" });
		const work = mkdtempSync(join(tmpdir(), "githive-mcp-"));
		try {
			const rogue = await agentClone(server.url, work, "rogue");
			rogue.write("hotfix.txt", "x\n");
			await rogue.run("add", "-A");
			await rogue.run("commit", "--quiet", "-m", "hotfix");
			await rogue.run("push", "--quiet", "origin", "main");
			const bad = await rogue.run("rev-parse", "HEAD");
			expect(await call("audit", { repo: "project" })).toMatchObject({ open: 1, violations: [{ commit: bad, rule: "undeclared" }] });
			expect(await call("revert", { repo: "project", commit: bad, agent: "agent-c" })).toMatchObject({ ok: true });
			const after = await call("audit", { repo: "project" });
			expect(after).toMatchObject({ open: 0, violations: [{ commit: bad, rule: "undeclared" }] });
			expect(after.violations[0].resolvedBy).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 60_000);

	it("notes a repo for the dashboard when the mode starts, and snapshots it", async () => {
		registered = [];
		await call("start", { repo: "project", verify: ["npm test"] });
		expect(registered).toEqual(["project"]);
		await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("vote", { repo: "project", commit: "h1", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const snapshot = await repoSnapshot(ctx().toolkit, "project");
		expect(snapshot).toMatchObject({
			repo: "project",
			policy: { required: 1, vetoes: [] },
			verify: ["npm test"],
			verified: false,
			// Each claim with where its change stands, and what GitHive's hosted agents on it are doing.
			claims: [{ change: "a-1", agent: "agent-a", paths: ["src/a/"], head: null, approval: { approved: false, approvals: 0, required: 1 }, hosted: { builder: { status: "working" } } }],
			votes: [{ commit: "h1", reviewer: "rev-1", verdict: "approve" }],
		});
		// The audit replays every record, so it's read on its own.
		expect(snapshot).not.toHaveProperty("audit");
		expect(await repoAudit(ctx().toolkit, "project")).toEqual({ merges: 0, open: 0, violations: [] });
	});

	it("keeps the repo's summary for the dashboard: activity on writes, counts when they're read", async () => {
		// Its own repo: activity is noted at most every 10 seconds per repo, and other tests write "project".
		summarized = [];
		await call("start", { repo: "summed" });
		await call("claim", { repo: "summed", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(summarized.at(-1)).toMatchObject({ repo: "summed", patch: { lastActivity: expect.any(String) } });
		expect(pinged).toContain("summed");
		expect(await openCount(ctx().toolkit, "summed")).toBe(1);
		await repoSnapshot(ctx().toolkit, "summed");
		expect(summarized.at(-1)).toMatchObject({ repo: "summed", patch: { open: 1, needsYou: 0, countedAt: expect.any(String) } });
		await repoAudit(ctx().toolkit, "summed");
		expect(summarized.at(-1)).toEqual({ repo: "summed", patch: { merged: 0, violations: 0 } });
		expect(await openCount(ctx().toolkit, "elsewhere")).toBeNull();
	});

	it("asks GitHive's hosted reviewers to review a claimed change, by default a general review and every veto role", async () => {
		reviewRequests = [];
		await call("start", { repo: "project", required: 2, vetoes: ["security"] });
		await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("request_review", { repo: "project", change: "a-1", summary: "adds a" })).toEqual({ head: "h1", reviewers: ["review", "security"] });
		expect(reviewRequests).toEqual([{ repo: "project", change: "a-1", roles: ["review", "security"], summary: "adds a" }]);
		await call("request_review", { repo: "project", change: "a-1", roles: ["api"] });
		expect(reviewRequests[1].roles).toEqual(["api"]);
		expect(await call("request_review", { repo: "project", change: "nope" })).toEqual({ error: "nope holds no claim: claim the change's paths first" });
	});

	it("claims paths for a new change and starts GitHive's hosted builder on it", async () => {
		builds = [];
		await call("start", { repo: "project" });
		const started = await call("build", { repo: "project", intent: "Add a stats page", paths: ["src/stats/"] });
		expect(started.change).toMatch(/^add-a-stats-page-[0-9a-f]{4}$/);
		expect(builds).toEqual([{ repo: "project", change: started.change }]);
		expect((await call("claims", { repo: "project" }))[0]).toMatchObject({ change: started.change, agent: "githive-builder", paths: ["src/stats/"], intent: "Add a stats page" });
		// Paths someone holds aren't built on.
		expect(await call("build", { repo: "project", intent: "More stats", paths: ["src/stats/x.ts"] })).toMatchObject({ ok: false, conflicts: [{ change: started.change }] });
		expect(builds).toHaveLength(1);
	});
});
