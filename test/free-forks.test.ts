import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callFreeTool, type FreeContext } from "../src/free/mcp";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Prevention, not just detection: each change lives in its own fork of the
// project repo, and an agent can write only to its own change's fork. Only the
// toolkit writes the project repo (main and the records), and only after the
// conventions hold, so an agent can't push around them.

let project: GitServer;
let fork: GitServer;
let work: string;
let forkRequests: { change: string; scope: string }[];

beforeEach(async () => {
	[project, fork] = await Promise.all([startGitServer(), startGitServer()]);
	work = mkdtempSync(join(tmpdir(), "free-forks-"));
	// A fork starts as a copy of the project.
	const seed = await agentClone(project.url, work, "seed");
	await seed.run("push", "--quiet", "--force", fork.url, "main");
	forkRequests = [];
});
afterEach(async () => {
	await Promise.all([project.close(), fork.close()]);
	rmSync(work, { recursive: true, force: true });
});

const ctx = (agentKey?: string): FreeContext => ({
	remote: async (_repo, scope) => ({ url: project.url, token: scope }),
	changeRemote: async (_repo, change, scope) => {
		forkRequests.push({ change, scope });
		return { url: fork.url, token: `fork-${scope}` };
	},
	head: async () => project.git("rev-parse", "main").trim(),
	...(agentKey ? { agentKey } : {}),
});
const call = async (name: string, args: Record<string, unknown>, agentKey?: string) => {
	try {
		return (await callFreeTool(name, { repo: "project", ...args }, ctx(agentKey))) as Record<string, unknown>;
	} catch (err) {
		return { error: statusOf(err).message };
	}
};

describe("forks (the default)", () => {
	beforeEach(async () => {
		await call("free_start", {});
	});

	it("gives an agent read access to the project, and write access only to its own change's fork", async () => {
		expect(await call("free_credentials", {})).toEqual({ url: project.url, token: "read", note: expect.stringMatching(/read-only/) });
		expect(await call("free_credentials", { change: "a-1" })).toEqual({ error: "a-1 holds no claim: claim its paths first" });
		const { key: keyA } = (await call("free_register", { agent: "agent-a" })) as { key: string };
		const { key: keyB } = (await call("free_register", { agent: "agent-b" })) as { key: string };
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" }, keyA);
		expect(await call("free_credentials", { change: "a-1" }, keyB)).toEqual({ error: "your agent key is agent-b's; it can't act as agent-a" });
		expect(await call("free_credentials", { change: "a-1" }, keyA)).toMatchObject({ url: fork.url, token: "fork-write", branch: "changes/a-1" });
		expect(forkRequests).toEqual([{ change: "a-1", scope: "write" }]);
	});

	it("merges a change from its fork into the project's main", async () => {
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const agent = await agentClone(fork.url, work, "agent-a");
		await agent.run("checkout", "--quiet", "-b", "changes/a-1");
		agent.write("src/a/x.txt", "a\n");
		await agent.run("add", "-A");
		await agent.run("commit", "--quiet", "-m", "a");
		await agent.run("push", "--quiet", "origin", "changes/a-1");
		const head = await agent.run("rev-parse", "HEAD");
		for (const reviewer of ["rev-1", "rev-2"]) await call("free_vote", { commit: head, reviewer, role: reviewer === "rev-1" ? "tests" : "security", verdict: "approve", evidence: "ok" });

		expect(await call("free_merge", { change: "a-1", agent: "agent-a" })).toMatchObject({ ok: true });
		expect(project.git("show", "main:src/a/x.txt")).toBe("a\n");
		// The project never had the branch: the change came from the fork.
		expect(project.git("branch", "--list", "changes/*").trim()).toBe("");
	}, 60_000);
});

describe("free_status", () => {
	it("tells an agent where its change stands: its claim, its branch head, the votes on it, and what's still needed", async () => {
		await call("free_start", {});
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("free_status", { change: "a-1" })).toMatchObject({ change: "a-1", claim: { agent: "agent-a", paths: ["src/a/"] }, head: null, votes: [] });

		const agent = await agentClone(fork.url, work, "agent-a");
		await agent.run("checkout", "--quiet", "-b", "changes/a-1");
		agent.write("src/a/x.txt", "a\n");
		await agent.run("add", "-A");
		await agent.run("commit", "--quiet", "-m", "a");
		await agent.run("push", "--quiet", "origin", "changes/a-1");
		const head = await agent.run("rev-parse", "HEAD");
		await call("free_vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "reject", evidence: "no tests" });
		await call("free_vote", { commit: "an-older-commit", reviewer: "rev-2", role: "tests", verdict: "approve", evidence: "ok" });

		expect(await call("free_status", { change: "a-1" })).toMatchObject({
			head,
			votes: [{ reviewer: "rev-1", verdict: "reject", evidence: "no tests" }],
			approval: { approved: false, approvals: 0, required: 2, vetoedBy: [] },
		});
	}, 60_000);

	it("says how a change ended once its claim is gone", async () => {
		await call("free_start", {});
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("free_release", { change: "a-1", agent: "agent-a", reason: "gave up" });
		expect(await call("free_status", { change: "a-1" })).toMatchObject({ claim: null, released: { reason: "gave up" } });
	});
});

describe("free_check (run by the agent itself)", () => {
	// Claims are exclusive and free_merge refuses files outside them, so two
	// mergeable changes can't conflict with each other: an overlap means someone
	// is outside their claim, which their own check already shows. So the check
	// is the change against main, and its files against its claim; it never
	// fetches other changes.
	it("warns early about conflicts with main and files outside the claim, without fetching other changes", async () => {
		await call("free_start", { shard_depth: 0 });
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("free_claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b" });
		const head = await pushChange(fork.url, work, "agent-a", "a-1", { "src/a/x.txt": "a\n", "README.md": "a's readme\n" });
		await pushChange(fork.url, work, "agent-b", "b-1", { "src/b/y.txt": "b\n", "README.md": "b's readme\n" });
		// Main moved under a-1, in a file a-1 changed too.
		const mainline = await agentClone(project.url, work, "mainline");
		mainline.write("README.md", "main's readme\n");
		await mainline.run("add", "-A");
		await mainline.run("commit", "--quiet", "-m", "readme");
		await mainline.run("push", "--quiet", "origin", "main");

		const before = project.requests.length;
		const beforeFork = fork.requests.length;
		expect(await call("free_check", { change: "a-1" })).toEqual({
			change: "a-1",
			head,
			branch: "main",
			main: { head: await mainline.run("rev-parse", "HEAD"), clean: false, conflicts: ["README.md"] },
			outsideClaim: ["README.md"],
		});
		// The claims registry and main from the project, the change from its fork: nothing of b-1's.
		expect(project.requests.slice(before).filter((r) => r === "POST git-upload-pack")).toHaveLength(2);
		expect(fork.requests.slice(beforeFork).filter((r) => r === "POST git-upload-pack")).toHaveLength(1);
	}, 60_000);

	it("says when there's nothing pushed to check", async () => {
		await call("free_start", {});
		await call("free_claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("free_check", { change: "a-1" })).toEqual({ error: "changes/a-1 has nothing pushed to check" });
	});
});
