import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { callTool, changeHistory, repoSnapshot, voteAsPerson, type ToolContext } from "../src/toolkit/mcp";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// Prevention, not just detection: each change lives in its own fork of the
// project repo, and an agent can write only to its own change's fork. Only the
// toolkit writes the project repo (main and the records), and only after the
// conventions hold, so an agent can't push around them.

let project: GitServer;
let fork: GitServer;
let work: string;
let forkRequests: { agent: string; scope: string }[];

beforeEach(async () => {
	[project, fork] = await Promise.all([startGitServer(), startGitServer()]);
	work = mkdtempSync(join(tmpdir(), "githive-forks-"));
	// A fork starts as a copy of the project.
	const seed = await agentClone(project.url, work, "seed");
	await seed.run("push", "--quiet", "--force", fork.url, "main");
	forkRequests = [];
});
afterEach(async () => {
	await Promise.all([project.close(), fork.close()]);
	rmSync(work, { recursive: true, force: true });
});

const ctx = (agentKey?: string): ToolContext => ({
	remote: async (_repo, scope) => ({ url: project.url, token: scope }),
	batchGit: () => memoryBatchGit({ url: project.url, token: "write" }),
	changeRemote: async (_repo, agent, scope) => {
		forkRequests.push({ agent, scope });
		return { url: fork.url, token: `fork-${scope}` };
	},
	head: async () => project.git("rev-parse", "main").trim(),
	...(agentKey ? { agentKey } : {}),
});
const call = async (name: string, args: Record<string, unknown>, agentKey?: string) => {
	try {
		return (await callTool(name, { repo: "project", ...args }, ctx(agentKey))) as Record<string, unknown>;
	} catch (err) {
		return { error: statusOf(err).message };
	}
};

describe("forks (the default)", () => {
	beforeEach(async () => {
		await call("start", {});
	});

	it("gives any reviewer read access to a change's branch in its author's fork, once something is pushed", async () => {
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		const { key: keyR } = (await call("register", { agent: "reviewer-1" })) as { key: string };
		expect(await call("review_access", { change: "a-1" }, keyR)).toEqual({ error: "no change a-1 on project" });
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a.ts"], intent: "a" }, keyA);
		expect(await call("review_access", { change: "a-1" }, keyR)).toEqual({ error: "a-1 has nothing pushed to review yet" });
		const head = await pushChange(fork.url, work, "agent-a", "a-1", { "src/a.ts": "a\n" });
		forkRequests = [];
		expect(await call("review_access", { change: "a-1" }, keyR)).toEqual({
			change: "a-1",
			author: "agent-a",
			url: fork.url,
			token: "fork-read",
			branch: "changes/a-1",
			head,
			// The role it's reviewed in (review, unless named): the reviewer's mark says so.
			role: "review",
			project: { url: project.url, token: "read", branch: "main" },
		});
		// Read access only, to the author's fork.
		expect(forkRequests).toEqual([{ agent: "agent-a", scope: "read" }]);
	});

	it("gives an agent read access to the project, and write access only to its own fork, shared by its changes", async () => {
		expect(await call("credentials", {})).toEqual({ url: project.url, token: "read", note: expect.stringMatching(/read-only/) });
		expect(await call("credentials", { change: "a-1" })).toEqual({ error: "a-1 holds no claim: claim its paths first" });
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		const { key: keyB } = (await call("register", { agent: "agent-b" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" }, keyA);
		expect(await call("credentials", { change: "a-1" }, keyB)).toEqual({ error: "you act as agent-b; you can't act as agent-a" });
		expect(await call("credentials", { change: "a-1" }, keyA)).toMatchObject({ url: fork.url, token: "fork-write", branch: "changes/a-1", project: { url: project.url, token: "read", branch: "main" } });
		// A second change by the same agent goes to the same fork, a branch of its own.
		await call("claim", { change: "a-2", agent: "agent-a", paths: ["src/a2/"], intent: "a, again" }, keyA);
		expect(await call("credentials", { change: "a-2" }, keyA)).toMatchObject({ branch: "changes/a-2" });
		expect(forkRequests).toEqual([{ agent: "agent-a", scope: "write" }, { agent: "agent-a", scope: "write" }]);
	});

	it("merges a change from its fork into the project's main", async () => {
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const agent = await agentClone(fork.url, work, "agent-a");
		await agent.run("checkout", "--quiet", "-b", "changes/a-1");
		agent.write("src/a/x.txt", "a\n");
		await agent.run("add", "-A");
		await agent.run("commit", "--quiet", "-m", "a");
		await agent.run("push", "--quiet", "origin", "changes/a-1");
		const head = await agent.run("rev-parse", "HEAD");
		for (const reviewer of ["rev-1", "rev-2"]) await call("vote", { commit: head, reviewer, role: reviewer === "rev-1" ? "tests" : "security", verdict: "approve", evidence: "ok" });

		expect(await call("merge", { change: "a-1", agent: "agent-a" })).toMatchObject({ ok: true });
		expect(project.git("show", "main:src/a/x.txt")).toBe("a\n");
		// The project never had the branch: the change came from the fork.
		expect(project.git("branch", "--list", "changes/*").trim()).toBe("");

		// Its page on the dashboard: the commit, the votes on it, and the merge.
		const history = await changeHistory(ctx(), "project", "a-1");
		expect(history).toMatchObject({ change: "a-1", branch: "main", claim: null, commits: [{ commit: head, message: "a", author: "agent-a" }] });
		expect(history.votes.map((v) => [v.reviewer, v.verdict])).toEqual([["rev-1", "approve"], ["rev-2", "approve"]]);
		expect(history.released).toEqual([expect.objectContaining({ reason: expect.stringMatching(/merged/), mergedAs: expect.stringMatching(/^[0-9a-f]{40}$/) })]);
		await expect(changeHistory(ctx(), "project", "nope")).rejects.toThrow(/\[404\] no change nope/);
	}, 60_000);
});

describe("status", () => {
	it("tells an agent where its change stands: its claim, its branch head, the votes on it, and what's still needed", async () => {
		await call("start", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("status", { change: "a-1" })).toMatchObject({ change: "a-1", claim: { agent: "agent-a", paths: ["src/a/"] }, head: null, votes: [] });

		const agent = await agentClone(fork.url, work, "agent-a");
		await agent.run("checkout", "--quiet", "-b", "changes/a-1");
		agent.write("src/a/x.txt", "a\n");
		await agent.run("add", "-A");
		await agent.run("commit", "--quiet", "-m", "a");
		await agent.run("push", "--quiet", "origin", "changes/a-1");
		const head = await agent.run("rev-parse", "HEAD");
		await call("vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "reject", evidence: "no tests" });
		await call("vote", { commit: "an-older-commit", reviewer: "rev-2", role: "tests", verdict: "approve", evidence: "ok" });

		expect(await call("status", { change: "a-1" })).toMatchObject({
			head,
			votes: [{ reviewer: "rev-1", verdict: "reject", evidence: "no tests" }],
			approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
		});
	}, 60_000);

	it("still finds a change made before forks were per agent, in that change's own fork", async () => {
		await call("start", {});
		await call("claim", { change: "old-1", agent: "agent-a", paths: ["src/old/"], intent: "from before" });
		// Its branch is in its own (older) fork; the agent's fork, here, doesn't have it.
		const head = await pushChange(fork.url, work, "agent-a", "old-1", { "src/old/x.txt": "x\n" });
		const older: ToolContext = { ...ctx(), changeRemote: async () => ({ url: project.url, token: "agent-fork" }), legacyChangeRemote: async () => ({ url: fork.url, token: "old-fork" }) };
		const status = (await callTool("status", { repo: "project", change: "old-1" }, older)) as { head: string };
		expect(status.head).toBe(head);
	}, 60_000);

	it("lets an agent ask a person about a change, until a person votes on its commit", async () => {
		await call("start", {});
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "Speed up the a module" }, keyA);
		const head = await pushChange(fork.url, work, "agent-a", "a-1", { "src/a/x.txt": "a\n" });
		const summaries: { repo: string; patch: Record<string, unknown> }[] = [];
		const watched = { ...ctx(), summarize: async (repo: string, patch: Record<string, unknown>) => void summaries.push({ repo, patch }) };
		expect(await callTool("ask_human", { repo: "project", change: "a-1", agent: "agent-a", reason: "reviewers disagree on the cache size" }, { ...watched, agentKey: keyA })).toMatchObject({ ok: true });
		// In the person's inbox at once, before anyone opens the repo.
		expect(summaries.at(-1)?.patch).toMatchObject({ needsYou: 1, waiting: [{ change: "a-1", reason: "reviewers disagree on the cache size" }] });

		const before = await repoSnapshot(watched, "project");
		expect(before.claims[0]).toMatchObject({ change: "a-1", attention: { reason: "reviewers disagree on the cache size", agent: "agent-a" } });
		expect(summaries.at(-1)?.patch).toMatchObject({ needsYou: 1, waiting: [{ change: "a-1", title: "Speed up the a module", reason: "reviewers disagree on the cache size" }] });

		// An agent can't pass itself off as a person to answer it.
		expect(await call("vote", { commit: head, reviewer: "person:abc", role: "review", verdict: "approve", evidence: "ok" })).toEqual({ error: "an agent's name can't contain \":\"" });
		// A person decides, from the dashboard; their vote counts and answers the question.
		const key = await generateStampKey();
		const person = { ...ctx(), stamper: async () => makeStamper(key.privateKey, "person:abc") };
		await expect(voteAsPerson(person, "project", "a-1", { role: "review", verdict: "approve", evidence: "ok" }, "service:a-script")).rejects.toThrow(/only a person/);
		expect(await voteAsPerson(person, "project", "a-1", { role: "review", verdict: "approve", evidence: "a cache of 64 is fine" }, "person:abc")).toEqual({ commit: head, role: "review", verdict: "approve" });
		const after = await repoSnapshot(watched, "project");
		expect(after.claims[0].attention).toBeUndefined();
		expect(after.votes[0]).toMatchObject({ commit: head, reviewer: "person:abc", role: "review", verdict: "approve" });
	}, 60_000);

	it("says how a change ended once its claim is gone", async () => {
		await call("start", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("release", { change: "a-1", agent: "agent-a", reason: "gave up" });
		expect(await call("status", { change: "a-1" })).toMatchObject({ claim: null, released: { reason: "gave up" } });
	});
});

describe("check (run by the agent itself)", () => {
	// Claims are exclusive and merge refuses files outside them, so two
	// mergeable changes can't conflict with each other: an overlap means someone
	// is outside their claim, which their own check already shows. So the check
	// is the change against main, and its files against its claim; it never
	// fetches other changes.
	it("warns early about conflicts with main and files outside the claim, without fetching other changes", async () => {
		await call("start", { shard_depth: 0 });
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b" });
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
		expect(await call("check", { change: "a-1" })).toEqual({
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
		await call("start", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("check", { change: "a-1" })).toEqual({ error: "changes/a-1 has nothing pushed to check" });
	});
});
