import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/election-git";
import { claimStore } from "../src/free/claim-store";
import { claim, startFree, type Registry } from "../src/free/claims";
import { type CheckRunner, mergeChange } from "../src/free/merge";
import { vote, type Votes } from "../src/free/votes";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The toolkit's merge: it test-merges the change into main first and reports a
// conflict as something the agent can act on, and it runs the project's checks
// on main plus the change before merging. The check runner is injected here;
// live, it is the Gate's container.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });
const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/blueprint-claims/t1");
const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/blueprint-votes/t1");
const policy = { required: 1, vetoes: [] };
const passing: CheckRunner = vi.fn(async () => ({ passed: true, results: [{ command: "npm test", exitCode: 0, output: "ok" }] }));

/** A change on its claim, pushed and approved. */
async function readyChange(change: string, files: Record<string, string>) {
	await claim(claims(), { change, agent: `agent-${change}`, paths: Object.keys(files), intent: change });
	const head = await pushChange(server.url, work, `agent-${change}`, change, files);
	await vote(votes(), { commit: head, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
	return head;
}

const merge = (change: string, runChecks: CheckRunner = passing) =>
	mergeChange({ remote: remote(), branch: "main", store: claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() }), votes: votes(), policy, verify: ["npm test"], runChecks, change, agent: `agent-${change}` });

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "blueprint-merge-"));
	await startFree(claims(), { baseline: server.git("rev-parse", "main").trim(), policy });
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("free_merge", { timeout: 60_000 }, () => {
	it("reports a conflict with main as something to resolve, and leaves main alone", async () => {
		const oldMain = server.git("rev-parse", "main").trim();
		await readyChange("a-1", { "shared.txt": "a\n" });
		expect(await merge("a-1")).toMatchObject({ ok: true });
		// b's branch started from the old main and changed the same file differently.
		await claim(claims(), { change: "b-1", agent: "agent-b-1", paths: ["shared.txt"], intent: "b" });
		const bHead = await pushChange(server.url, work, "agent-b-1", "b-1", { "shared.txt": "b\n" }, oldMain);
		await vote(votes(), { commit: bHead, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
		const main = server.git("rev-parse", "main").trim();
		expect(await merge("b-1")).toEqual({
			ok: false,
			conflicts: ["shared.txt"],
			reasons: ["changes/b-1 conflicts with main in shared.txt: merge main into your branch, resolve inside your claim, push, and get the new commit approved"],
		});
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("refuses a change approved only by its own author", async () => {
		await claim(claims(), { change: "a-1", agent: "agent-a-1", paths: ["src/a.txt"], intent: "a" });
		const head = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		await vote(votes(), { commit: head, reviewer: "agent-a-1", role: "tests", verdict: "approve", evidence: "I checked my own work" });
		expect(await merge("a-1")).toEqual({ ok: false, reasons: [`${head} has 0 of 1 approvals from reviewers other than its author`] });
	});

	it("runs the checks on main plus the change, and refuses to merge when they fail", async () => {
		const head = await readyChange("a-1", { "src/a.txt": "a\n" });
		const main = server.git("rev-parse", "main").trim();
		const failing: CheckRunner = vi.fn(async () => ({ passed: false, results: [{ command: "npm test", exitCode: 1, output: "1 failing" }] }));
		expect(await merge("a-1", failing)).toEqual({ ok: false, reasons: ["checks failed: npm test exited 1"], checks: [{ command: "npm test", exitCode: 1, output: "1 failing" }] });
		expect(failing).toHaveBeenCalledWith({ base: main, branch: "main", head, ref: "changes/a-1", commands: ["npm test"] });
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("records on the merge which main the checks passed on", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const main = server.git("rev-parse", "main").trim();
		const merged = await merge("a-1");
		expect(merged).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=Blueprint-Tested,valueonly)", "main").trim()).toBe(main);
	});
});
