import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchHead, defaultBranch, Workspace } from "../src/git";
import { handleRpc } from "../src/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// A project's branch is whatever its repo's HEAD names: main, master, trunk.
// Here the project's only branch is master, and nothing may assume main.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });

beforeEach(async () => {
	server = await startGitServer({ branch: "master" });
	work = mkdtempSync(join(tmpdir(), "branch-support-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a project whose branch is master", () => {
	it("is found where the repo's HEAD points", async () => {
		expect(await defaultBranch(remote())).toBe("master");
	});

	it("is what a workspace clones, merges onto and pushes", async () => {
		const ws = await Workspace.clone(remote(), "master");
		expect(ws.branch).toBe("master");
		await ws.write({ "notes.txt": "hello\n" });
		await ws.commit("Add notes");
		await ws.push();
		expect(server.git("rev-parse", "master").trim()).toBe(await ws.head());
		expect(await branchHead(remote(), "main")).toBeNull();
	});

	it("runs GitHive end to end: started, checked, merged and audited on master", async () => {
		// A change's fork starts as a copy of the project: master, and nothing else.
		const forkUrl = server.repo("fork");
		// Pushed by path: git over HTTP would wait on this process's own server.
		const repos = join(server.git("rev-parse", "--absolute-git-dir").trim(), "..");
		server.git("push", "--quiet", join(repos, "fork.git"), "master");
		server.gitIn("fork", "symbolic-ref", "HEAD", "refs/heads/master");
		const ctx = {
			toolkit: {
				remote: async () => remote(),
				batchGit: () => memoryBatchGit(remote()),
				changeRemote: async () => ({ url: forkUrl, token: "unused" }),
				head: async (_repo: string, branch: string) => (await branchHead(remote(), branch)) ?? "",
				defaultBranch: async () => (await defaultBranch(remote()))!,
			},
		};
		const call = async (name: string, args: Record<string, unknown>) => {
			const reply = (await handleRpc(
				{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
				ctx as never,
			)) as { result: { content: { text: string }[]; isError?: boolean } };
			const text = reply.result.content[0].text;
			return reply.result.isError ? { error: text } : JSON.parse(text);
		};

		expect(await call("settings", { repo: "project", shard_depth: 0 })).toMatchObject({ branch: "master" });
		await call("claim", { repo: "project", change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const head = await pushChange(forkUrl, work, "agent-a", "a-1", { "src/a/x.txt": "a\n" });
		expect(await call("check", { repo: "project", change: "a-1" })).toMatchObject({
			branch: "master",
			main: { clean: true },
			outsideClaim: [],
		});
		await call("vote", {
			repo: "project",
			commit: head,
			reviewer: "rev-1",
			role: "tests",
			verdict: "approve",
			evidence: "ok",
		});
		await call("vote", {
			repo: "project",
			commit: head,
			reviewer: "rev-2",
			role: "security",
			verdict: "approve",
			evidence: "ok",
		});

		expect(await call("merge", { repo: "project", change: "a-1", agent: "agent-a" })).toMatchObject({ ok: true });
		// The merge is on master, which has the change; no main branch was made.
		expect(server.git("show", "master:src/a/x.txt")).toBe("a\n");
		expect(await branchHead(remote(), "main")).toBeNull();
		expect(await call("audit", { repo: "project" })).toEqual({ merges: 1, open: 0, violations: [] });
	});
});
