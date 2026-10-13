import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		await call("settings", {});
	});

	it("gives any reviewer read access to another agent's change in its fork, once something is pushed", async () => {
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		const { key: keyR } = (await call("register", { agent: "reviewer-1" })) as { key: string };
		expect(await call("credentials", { change: "a-1" }, keyR)).toEqual({ error: "no change a-1 on project" });
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a.ts"], intent: "a" }, keyA);
		expect(await call("credentials", { change: "a-1" }, keyR)).toEqual({
			error: "a-1 has nothing pushed to review yet",
		});
		const head = await pushChange(fork.url, work, "agent-a", "a-1", { "src/a.ts": "a\n" });
		forkRequests = [];
		expect(await call("credentials", { change: "a-1" }, keyR)).toEqual({
			change: "a-1",
			author: "agent-a",
			url: fork.url,
			token: "fork-read",
			branch: "changes/a-1",
			head,
			// The reviewer's mark records the role, which defaults to review.
			role: "review",
			project: { url: project.url, token: "read", branch: "main" },
			git: { setup: expect.any(Array), diff: `git diff origin/main...${head}` },
			note: expect.stringMatching(/read-only/),
			next: `Run the \`git\` setup commands, read the diff, then \`vote\` on ${head} as review, with what you checked as evidence. If you've been building in this session, review in a fresh one (a subagent or a new session).`,
		});
		// Read-only access to the author's fork.
		expect(forkRequests).toEqual([{ agent: "agent-a", scope: "read" }]);
	});

	it("gives an agent read access to the project and write access only to its own fork, for every change", async () => {
		expect(await call("credentials", {})).toEqual({
			url: project.url,
			token: "read",
			note: expect.stringMatching(/read-only/),
		});
		expect(await call("credentials", { change: "a-1" })).toEqual({ error: "no change a-1 on project" });
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		const { key: keyB } = (await call("register", { agent: "agent-b" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" }, keyA);
		// Another agent asking for the change gets read access to review it, never write: nothing's pushed yet.
		expect(await call("credentials", { change: "a-1" }, keyB)).toEqual({
			error: "a-1 has nothing pushed to review yet",
		});
		expect(forkRequests.filter((request) => request.scope === "write")).toEqual([]);
		forkRequests = [];
		expect(await call("credentials", { change: "a-1" }, keyA)).toMatchObject({
			url: fork.url,
			token: "fork-write",
			branch: "changes/a-1",
			project: { url: project.url, token: "read", branch: "main" },
		});
		// A second change by the same agent goes to the same fork, a branch of its own.
		await call("claim", { change: "a-2", agent: "agent-a", paths: ["src/a2/"], intent: "a, again" }, keyA);
		expect(await call("credentials", { change: "a-2" }, keyA)).toMatchObject({ branch: "changes/a-2" });
		expect(forkRequests).toEqual([
			{ agent: "agent-a", scope: "write" },
			{ agent: "agent-a", scope: "write" },
		]);
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
		for (const reviewer of ["rev-1", "rev-2"])
			await call("vote", {
				commit: head,
				reviewer,
				role: reviewer === "rev-1" ? "tests" : "security",
				verdict: "approve",
				evidence: "ok",
			});

		expect(await call("merge", { change: "a-1", agent: "agent-a" })).toMatchObject({ ok: true });
		expect(project.git("show", "main:src/a/x.txt")).toBe("a\n");
		// The project never had the branch: the change came from the fork.
		expect(project.git("branch", "--list", "changes/*").trim()).toBe("");

		// Its page on the dashboard: the commit, the votes on it, and the merge.
		const history = await changeHistory(ctx(), "project", "a-1");
		expect(history).toMatchObject({
			change: "a-1",
			branch: "main",
			claim: null,
			commits: [{ commit: head, message: "a", author: "agent-a" }],
		});
		expect(history.votes.map((v) => [v.reviewer, v.verdict])).toEqual([
			["rev-1", "approve"],
			["rev-2", "approve"],
		]);
		expect(history.released).toEqual([
			expect.objectContaining({
				reason: expect.stringMatching(/merged/),
				mergedAs: expect.stringMatching(/^[0-9a-f]{40}$/),
			}),
		]);
		await expect(changeHistory(ctx(), "project", "nope")).rejects.toThrow(/\[404\] no change nope/);
	}, 60_000);
});

describe("status", () => {
	it("tells an agent where its change stands: its claim, branch head, votes, and what's still needed", async () => {
		await call("settings", { required: 1 });
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		expect(await call("status", { change: "a-1" })).toMatchObject({
			change: "a-1",
			claim: { agent: "agent-a", paths: ["src/a/"] },
			head: null,
			votes: [],
		});

		const agent = await agentClone(fork.url, work, "agent-a");
		await agent.run("checkout", "--quiet", "-b", "changes/a-1");
		agent.write("src/a/x.txt", "a\n");
		await agent.run("add", "-A");
		await agent.run("commit", "--quiet", "-m", "a");
		await agent.run("push", "--quiet", "origin", "changes/a-1");
		const head = await agent.run("rev-parse", "HEAD");
		await call("vote", { commit: head, reviewer: "rev-1", role: "tests", verdict: "reject", evidence: "no tests" });
		await call("vote", {
			commit: "an-older-commit",
			reviewer: "rev-2",
			role: "tests",
			verdict: "approve",
			evidence: "ok",
		});

		expect(await call("status", { change: "a-1" })).toMatchObject({
			head,
			votes: [{ reviewer: "rev-1", verdict: "reject", evidence: "no tests" }],
			approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
		});
	}, 60_000);

	it("reads a change's head with one Artifacts log on its agent's fork, without a token or Git listing", async () => {
		await call("settings", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const asked: string[] = [];
		const viaApi: ToolContext = {
			...ctx(),
			forkHead: async (_repo, agent, ref) => (asked.push(`${agent} ${ref}`), "c0ffee"),
			changeRemote: async () => {
				throw new Error("a Git remote was asked for");
			},
		};
		const status = (await callTool("status", { repo: "project", change: "a-1" }, viaApi)) as { head: string };
		expect(status.head).toBe("c0ffee");
		expect(asked).toEqual(["agent-a changes/a-1"]);
	});

	it("still finds a change made before forks were per agent, in that change's own fork", async () => {
		await call("settings", {});
		// Only a change claimed before forks were per agent can have its own fork.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
		try {
			await call("claim", { change: "old-1", agent: "agent-a", paths: ["src/old/"], intent: "from before" });
		} finally {
			vi.useRealTimers();
		}
		// Its branch is in its own (older) fork; the agent's fork, here, doesn't have it.
		const head = await pushChange(fork.url, work, "agent-a", "old-1", { "src/old/x.txt": "x\n" });
		const older: ToolContext = {
			...ctx(),
			changeRemote: async () => ({ url: project.url, token: "agent-fork" }),
			legacyChangeRemote: async () => ({ url: fork.url, token: "old-fork" }),
		};
		const status = (await callTool("status", { repo: "project", change: "old-1" }, older)) as { head: string };
		expect(status.head).toBe(head);
	}, 60_000);

	it("lets an agent ask a person about a change, until a person votes on its commit", async () => {
		await call("settings", {});
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "Speed up the a module" }, keyA);
		const head = await pushChange(fork.url, work, "agent-a", "a-1", { "src/a/x.txt": "a\n" });
		const summaries: { repo: string; patch: Record<string, unknown> }[] = [];
		const watched = {
			...ctx(),
			summarize: async (repo: string, patch: Record<string, unknown>) => void summaries.push({ repo, patch }),
		};
		expect(
			await callTool(
				"ask_human",
				{ repo: "project", change: "a-1", agent: "agent-a", reason: "reviewers disagree on the cache size" },
				{ ...watched, agentKey: keyA },
			),
		).toMatchObject({ ok: true });
		// In the person's inbox at once, before anyone opens the repo.
		expect(summaries.at(-1)?.patch).toMatchObject({
			needsYou: 1,
			waiting: [{ change: "a-1", reason: "reviewers disagree on the cache size" }],
		});

		const before = await repoSnapshot(watched, "project");
		expect(before.claims[0]).toMatchObject({
			change: "a-1",
			attention: { reason: "reviewers disagree on the cache size", agent: "agent-a" },
		});
		expect(summaries.at(-1)?.patch).toMatchObject({
			needsYou: 1,
			waiting: [{ change: "a-1", title: "Speed up the a module", reason: "reviewers disagree on the cache size" }],
		});

		// An agent can't pass itself off as a person to answer it.
		expect(
			await call("vote", { commit: head, reviewer: "person:abc", role: "review", verdict: "approve", evidence: "ok" }),
		).toEqual({ error: "an agent's name can't contain \":\"" });
		// A person decides, from the dashboard; their vote counts and answers the question.
		const key = await generateStampKey();
		const person = { ...ctx(), stamper: async () => makeStamper(key.privateKey, "person:abc") };
		await expect(
			voteAsPerson(
				person,
				"project",
				"a-1",
				{ role: "review", verdict: "approve", evidence: "ok" },
				"service:a-script",
			),
		).rejects.toThrow(/only a person/);
		expect(
			await voteAsPerson(
				person,
				"project",
				"a-1",
				{ role: "review", verdict: "approve", evidence: "a cache of 64 is fine" },
				"person:abc",
			),
		).toEqual({ commit: head, role: "review", verdict: "approve" });
		const after = await repoSnapshot(watched, "project");
		expect(after.claims[0]!.attention).toBeUndefined();
		expect(after.votes[0]).toMatchObject({ commit: head, reviewer: "person:abc", role: "review", verdict: "approve" });
	}, 60_000);

	it("says how a change ended once its claim is gone", async () => {
		await call("settings", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("release", { change: "a-1", agent: "agent-a", reason: "gave up" });
		expect(await call("status", { change: "a-1" })).toMatchObject({ claim: null, released: { reason: "gave up" } });
	});
});

describe("check (run by the agent itself)", () => {
	// Claims are exclusive and merge refuses files outside them, so two mergeable changes can't conflict. An
	// overlap means someone is outside their claim, which their own check already shows. So the check compares the
	// change against main and its files against its claim, and never fetches other changes.
	it("warns early about conflicts with main and files outside the claim, without fetching other changes", async () => {
		await call("settings", { shard_depth: 0 });
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await call("claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b" });
		const head = await pushChange(fork.url, work, "agent-a", "a-1", {
			"src/a/x.txt": "a\n",
			"README.md": "a's readme\n",
		});
		await pushChange(fork.url, work, "agent-b", "b-1", { "src/b/y.txt": "b\n", "README.md": "b's readme\n" });
		// Main moved under a-1, in a file a-1 changed too.
		const mainline = await agentClone(project.url, work, "mainline");
		mainline.write("README.md", "main's readme\n");
		await mainline.run("add", "-A");
		await mainline.run("commit", "--quiet", "-m", "readme");
		await mainline.run("push", "--quiet", "origin", "main");

		const branchHead = (await mainline.run("rev-parse", "HEAD")).trim();
		expect(await call("status", { change: "a-1" })).toMatchObject({
			head,
			merge: {
				into: "main",
				branchHead,
				clean: false,
				conflicts: ["README.md"],
				// Pushed to main with plain git, so no landing names it: its author does.
				touchedBy: [{ file: "README.md", commit: branchHead, author: "mainline", intent: "readme" }],
				hunks: [
					{
						file: "README.md",
						content: expect.stringMatching(/^<<<<<<< ours \(changes\/a-1\)\n[\s\S]*>>>>>>> origin\/main\n$/),
						truncated: false,
					},
				],
				fix: expect.arrayContaining(["git fetch origin main && git merge origin/main"]),
				outsideClaim: ["README.md"],
			},
		});
	}, 60_000);

	it("works out a change's merge once per change head and branch head, then reads it from the cache", async () => {
		const kept = new Map<string, { key: string; result: unknown }>();
		let worked = 0;
		const caching = (): ToolContext => ({
			...ctx(),
			mergeChecks: {
				kept: async (_repo, change) => kept.get(change) ?? null,
				keep: async (_repo, change, entry) => void (worked++, kept.set(change, entry)),
			},
		});
		const status = (change: string) =>
			callTool("status", { repo: "project", change }, caching()) as Promise<Record<string, unknown>>;
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		await pushChange(fork.url, work, "agent-a", "a-1", { "src/a/x.ts": "a\n" });
		expect((await status("a-1")).merge).toMatchObject({ clean: true, outsideClaim: [] });
		expect((await status("a-1")).merge).toMatchObject({ clean: true });
		expect(worked).toBe(1);
		// A new push is a new head: worked out again.
		await pushChange(fork.url, work, "agent-a", "a-1", { "src/a/x.ts": "a, again\n" }, "origin/changes/a-1");
		expect((await status("a-1")).merge).toMatchObject({ clean: true });
		expect(worked).toBe(2);
	});

	it("hands out git commands that work as given: to push a change, and to review it", async () => {
		// The project's main moved on after the fork was made, so the fork's own copy is behind.
		const lander = await agentClone(project.url, work, "lander");
		lander.write("landed.txt", "landed\n");
		await lander.run("add", "landed.txt");
		await lander.run("commit", "-qm", "landed");
		await lander.run("push", "--quiet", "origin", "main");
		const main = project.git("rev-parse", "main").trim();
		// Asynchronously: the test's git servers run in this process, so a blocking call would wait on itself.
		const run = promisify(execFile);
		const identity = {
			GIT_AUTHOR_NAME: "a",
			GIT_AUTHOR_EMAIL: "a@x",
			GIT_COMMITTER_NAME: "a",
			GIT_COMMITTER_EMAIL: "a@x",
		};
		const shell = async (directory: string, commands: string[]) =>
			(await run("bash", ["-c", commands.join(" && ")], { cwd: directory, env: { ...process.env, ...identity } }))
				.stdout;
		const { key: keyA } = (await call("register", { agent: "agent-a" })) as { key: string };
		const { key: keyR } = (await call("register", { agent: "reviewer-1" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" }, keyA);
		const own = (await call("credentials", { change: "a-1" }, keyA)) as { git: { setup: string[]; push: string } };
		// The clone comes from the fork; the project serves only what main gained since.
		expect(own.git.setup[0]).toContain(`clone --origin fork ${fork.url}`);
		const author = mkdtempSync(join(work, "author-"));
		await shell(author, own.git.setup);
		writeFileSync(join(author, "a-1", "added.txt"), "added\n");
		await shell(join(author, "a-1"), ["git add added.txt", "git commit -qm add", own.git.push]);
		const head = fork.git("rev-parse", "changes/a-1").trim();
		// Cloned from the fork, but started from the project's main as it is now.
		expect(fork.git("rev-parse", `${head}^`).trim()).toBe(main);
		const review = (await call("credentials", { change: "a-1" }, keyR)) as { git: { setup: string[]; diff: string } };
		const reviewer = mkdtempSync(join(work, "reviewer-"));
		await shell(reviewer, review.git.setup);
		expect((await shell(join(reviewer, "review-a-1"), ["git rev-parse HEAD"])).trim()).toBe(head);
		expect(await shell(join(reviewer, "review-a-1"), [review.git.diff])).toContain("+added");
	});

	it("says nothing about merging while nothing's pushed", async () => {
		await call("settings", {});
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" });
		const status = (await call("status", { change: "a-1" })) as Record<string, unknown>;
		expect(status.head).toBeNull();
		expect(status).not.toHaveProperty("merge");
	});
});
