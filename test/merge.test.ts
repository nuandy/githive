import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claimStore } from "../src/toolkit/claim-store";
import { claim, startRepo, type Registry } from "../src/toolkit/claims";
import { type CheckRunner, mergeChange } from "../src/toolkit/merge";
import { vote, type Votes } from "../src/toolkit/votes";
import { voteStore } from "../src/toolkit/vote-store";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// The toolkit's merge: it test-merges the change into main first and reports a
// conflict as something the agent can act on, and it runs the project's checks
// on main plus the change (and whatever else is ready to land with it) before
// merging. The check runner is injected here; live, it is the Gate's container.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });
const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/githive-claims/t1");
const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/githive-votes/t1");
const policy = { required: 1, vetoes: [] };
const passing: CheckRunner = vi.fn(async () => ({
	passed: true,
	results: [{ command: "npm test", exitCode: 0, output: "ok" }],
}));

/** A change on its claim, pushed and approved. */
async function readyChange(change: string, files: Record<string, string>) {
	await claim(claims(), { change, agent: `agent-${change}`, paths: Object.keys(files), intent: change });
	const head = await pushChange(server.url, work, `agent-${change}`, change, files);
	await vote(votes(), { commit: head, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
	return head;
}

const merge = (change: string, runChecks: CheckRunner = passing) =>
	mergeChange({
		remote: remote(),
		batchGit: memoryBatchGit(remote()),
		branch: "main",
		store: claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() }),
		votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
		policy,
		verify: ["npm test"],
		runChecks,
		change,
		agent: `agent-${change}`,
	});

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-merge-"));
	await startRepo(claims(), { baseline: server.git("rev-parse", "main").trim(), policy });
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("merge", { timeout: 60_000 }, () => {
	it("reports a conflict with main as something to resolve, and leaves main alone", async () => {
		const oldMain = server.git("rev-parse", "main").trim();
		await readyChange("a-1", { "shared.txt": "a\n" });
		expect(await merge("a-1")).toMatchObject({ ok: true });
		// b's branch started from the old main and changed the same file differently.
		await claim(claims(), { change: "b-1", agent: "agent-b-1", paths: ["shared.txt"], intent: "b" });
		const bHead = await pushChange(server.url, work, "agent-b-1", "b-1", { "shared.txt": "b\n" }, oldMain);
		await vote(votes(), { commit: bHead, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
		const main = server.git("rev-parse", "main").trim();
		// It says who changed the file since b-1 left main, shows the file with its conflict markers, and how to fix it.
		expect(await merge("b-1")).toEqual({
			ok: false,
			conflicts: ["shared.txt"],
			touchedBy: [{ file: "shared.txt", commit: main, change: "a-1", agent: "agent-a-1", intent: "a-1" }],
			why: ["conflict"],
			into: "main",
			head: bHead,
			// b-1's side first, as `git merge origin/main` shows it in its agent's clone.
			hunks: [
				{
					file: "shared.txt",
					content: "<<<<<<< ours (changes/b-1)\nb\n=======\na\n>>>>>>> origin/main\n",
					truncated: false,
				},
			],
			fix: [
				"git fetch origin main && git merge origin/main",
				"# resolve shared.txt so both changes make sense, then:",
				"git add -u && git commit --no-edit",
				"git push fork changes/b-1",
				"call status; once the new commit is approved, merge again",
			],
			reasons: [
				`changes/b-1 conflicts with main in shared.txt (changed by a-1, agent-a-1: "a-1", ${main.slice(0, 8)}): ` +
					"merge main into your branch, resolve inside your claim, push, and get the new commit approved; see " +
					"touchedBy, hunks and fix",
			],
		});
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("refuses a change approved only by its own author", async () => {
		await claim(claims(), { change: "a-1", agent: "agent-a-1", paths: ["src/a.txt"], intent: "a" });
		const head = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		await vote(votes(), {
			commit: head,
			reviewer: "agent-a-1",
			role: "tests",
			verdict: "approve",
			evidence: "I checked my own work",
		});
		expect(await merge("a-1")).toEqual({
			ok: false,
			reasons: [`${head} has 0 of 1 approvals from reviewers other than its author`],
			why: ["approvals"],
		});
	});

	it("runs the checks on main plus the change, and refuses to merge when they fail twice", async () => {
		const head = await readyChange("a-1", { "src/a.txt": "a\n" });
		const main = server.git("rev-parse", "main").trim();
		const failing: CheckRunner = vi.fn(async () => ({
			passed: false,
			results: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
		}));
		expect(await merge("a-1", failing)).toEqual({
			ok: false,
			reasons: ["checks failed: npm test exited 1"],
			why: ["checks"],
			checks: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
		});
		expect(failing).toHaveBeenCalledWith({
			base: main,
			branch: "main",
			changes: [{ change: "a-1", head, ref: "changes/a-1", agent: "agent-a-1" }],
			commands: ["npm test"],
			gate: expect.stringMatching(/-0$/),
		});
		expect(failing).toHaveBeenCalledTimes(2);
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("records on the merge which main the checks passed on", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const main = server.git("rev-parse", "main").trim();
		const merged = await merge("a-1");
		expect(merged).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Tested,valueonly)", "main").trim()).toBe(main);
	});
});
