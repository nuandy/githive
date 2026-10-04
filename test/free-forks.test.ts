import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callFreeTool, type FreeContext } from "../src/free/mcp";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Prevention, not just detection: by default each change lives in its own fork
// of the project repo, and an agent can write only to its own change's fork.
// Only the toolkit writes the project repo (main and the records), and only
// after the conventions hold, so an agent can't push around them. With
// access: "shared", agents get the project repo itself, and the audit is all
// there is.

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

describe('access: "shared"', () => {
	it("gives any agent write access to the project repo, as before", async () => {
		await call("free_start", { access: "shared" });
		expect(await call("free_credentials", {})).toMatchObject({ url: project.url, token: "write" });
		expect(forkRequests).toEqual([]);
	});
});
