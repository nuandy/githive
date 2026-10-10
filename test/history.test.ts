import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BranchCommit } from "../src/toolkit/git-records";
import { branchHistory } from "../src/toolkit/history";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// A branch's history, as the History tab shows it: each landed change with why
// it was made and who reviewed it, newest first, read from Git alone.

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-history-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/** A branch's first-parent commits after `baseline`, oldest first, as `git log` tells them. */
function readBranch(_repo: string, baseline: string, branch: string): Promise<BranchCommit[]> {
	const range = `${baseline}..${branch}`;
	const log = server.git("log", "--first-parent", "--reverse", "--format=%H%x00%P%x00%an%x00%B%x1e", range);
	const commits = log.split("\x1e").filter((entry) => entry.trim());
	return Promise.resolve(
		commits.map((entry) => {
			const fields = entry.replace(/^\n/, "").split("\0");
			const [commit, parents, author, message] = fields as [string, string, string, string];
			const files = server.git("diff-tree", "--no-commit-id", "-r", "--name-only", `${commit}^1`, commit);
			return { commit, parents: parents.split(" "), author, message: message.trim(), files: files.trim().split("\n") };
		}),
	);
}

const context = (agentKey?: string): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
	readBranch,
	...(agentKey ? { agentKey } : {}),
});
const call = (name: string, args: Record<string, unknown>, key?: string) =>
	callTool(name, { repo: "p", ...args }, context(key)) as Promise<Record<string, unknown>>;

/** Claim, push, approve and merge a change: what an agent and its reviewer do. */
async function land(change: string, intent: string, evidence: string) {
	const agent = `agent-${change}`;
	const { key } = (await call("register", { agent })) as { key: string };
	await call("claim", { change, agent, paths: [`src/${change}/`], intent }, key);
	const head = await pushChange(server.url, work, agent, change, { [`src/${change}/x.js`]: `${change}\n` });
	await call("vote", { commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence });
	expect(await call("merge", { change, agent }, key)).toMatchObject({ ok: true });
	return head;
}

describe("a branch's history", { timeout: 120_000 }, () => {
	it("lists each landed change, newest first, with its intent and the reviews it landed with", async () => {
		await call("settings", { required: 1 });
		const first = await land("login-limit", "Rate-limit logins so guessing passwords is slow", "Ran the login tests");
		const second = await land("docs-1", "Explain the rate limit in the README", "Read it through");
		const history = await branchHistory(context(), "p");
		expect(history).toMatchObject({ branch: "main", total: 2 });
		expect(history.changes.map((entry) => [entry.change, entry.title, entry.head])).toEqual([
			["docs-1", "Explain the rate limit in the README", second],
			["login-limit", "Rate-limit logins so guessing passwords is slow", first],
		]);
		expect(history.changes[1]).toMatchObject({
			agent: "agent-login-limit",
			intent: "Rate-limit logins so guessing passwords is slow",
			files: ["src/login-limit/x.js"],
			reviews: [{ reviewer: "reviewer", role: "review", verdict: "approve", evidence: "Ran the login tests" }],
		});
	});

	it("is empty before anything lands, and refuses a branch GitHive lands nothing on", async () => {
		await call("settings", {});
		expect(await branchHistory(context(), "p")).toEqual({ branch: "main", total: 0, changes: [] });
		await expect(branchHistory(context(), "p", "nowhere")).rejects.toThrow("lands nothing on nowhere");
	});
});
