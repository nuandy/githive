import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesBranch, ruleFor, settingsForBranch } from "../src/toolkit/branch-rules";
import { callTool, repoSnapshot, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// A branch may have settings of its own, by pattern: feature/* with checks
// only, release/* needing a person's approval. A rule changes only what it
// names; the rest stay the repo's, and the project's branch always has the
// repo's settings.

describe("branch rules", () => {
	it("name branches by pattern, * standing for any run of characters", () => {
		expect(matchesBranch("feature/*", "feature/checkout")).toBe(true);
		expect(matchesBranch("feature/*", "feature/a/b")).toBe(true);
		expect(matchesBranch("feature/*", "features/x")).toBe(false);
		expect(matchesBranch("release/2.x", "release/2.x")).toBe(true);
		expect(matchesBranch("release/2.x", "release/2-x")).toBe(false);
	});

	it("give a branch the first matching rule's changes over the repo's settings, and the project's branch none", () => {
		const rules = [{ pattern: "feature/*", policy: { required: 0 } }, { pattern: "*", verify: [] as string[] }];
		expect(ruleFor(rules, "feature/x", "main")?.pattern).toBe("feature/*");
		expect(ruleFor(rules, "main", "main")).toBeUndefined();
		const repo = { policy: { required: 2, vetoes: ["security"] }, verify: ["npm test"], rules, project: "main" };
		expect(settingsForBranch(repo, "feature/x")).toEqual({ policy: { required: 0, vetoes: ["security"] }, verify: ["npm test"], rule: "feature/*" });
		expect(settingsForBranch(repo, "release/2.x")).toEqual({ policy: { required: 2, vetoes: ["security"] }, verify: [], rule: "*" });
		expect(settingsForBranch(repo, "main")).toEqual({ policy: repo.policy, verify: ["npm test"] });
	});
});

let server: GitServer;
let work: string;
const keys: Record<string, string> = {};
const ctx = (agentKey?: string): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
	changeRemote: async () => ({ url: server.url, token: "unused" }),
	head: async (_repo, branch) => server.git("rev-parse", branch).trim(),
	...(agentKey ? { agentKey } : {}),
});
const call = (name: string, args: Record<string, unknown>, as?: string) => callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;

/** A change claimed into `into` (made from main if it's new) and pushed: its head. */
async function pushed(change: string, into?: string) {
	await call("claim", { change, agent: "a", paths: [`src/${change}/`], intent: change, ...(into ? { into, from: "main" } : {}) }, "a");
	return pushChange(server.url, work, "a", change, { [`src/${change}/x.js`]: "x\n" }, into ? `origin/${into}` : undefined);
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-branch-rules-"));
	await call("settings", { required: 1, vetoes: [], verify: ["npm test"] });
	for (const agent of ["a", "reviewer"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a repo's branch rules", () => {
	it("let feature branches merge on their own, while main keeps its review and checks; the audit agrees", async () => {
		expect(await call("settings", { branch_rules: [{ pattern: "feature/*", required: 0, verify: [] }] })).toMatchObject({ branchRules: [{ pattern: "feature/*", policy: { required: 0 }, verify: [] }] });
		await pushed("quick", "feature/quick");
		expect((await repoSnapshot(ctx(), "p")).claims[0]).toMatchObject({ change: "quick", approval: { approved: true, required: 0 } });
		expect(await call("merge", { change: "quick", agent: "a" }, "a")).toMatchObject({ ok: true });
		// On main: one approval, and the checks (which nothing here can run).
		await pushed("careful");
		expect(await call("merge", { change: "careful", agent: "a" }, "a")).toMatchObject({ ok: false, reasons: [expect.stringContaining("0 of 1 approvals")] });
		expect(await call("audit", {})).toMatchObject({ merges: 1, open: 0 });
	});

	it("can require a role only people hold, on release branches", async () => {
		await call("settings", { branch_rules: [{ pattern: "release/*", vetoes: ["release"], grants: { release: ["person:*"] } }] });
		const head = await pushed("fix", "release/2.x");
		await call("vote", { commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" }, "reviewer");
		expect(await call("merge", { change: "fix", agent: "a" }, "a")).toMatchObject({ ok: false, reasons: [expect.stringContaining("still needs approval from release")] });
		expect(await call("status", { change: "fix" }, "a")).toMatchObject({ approval: { approved: false, awaiting: ["release"] } });
	});

	it("are refused when a rule names nothing to change, or its pattern isn't a branch name", async () => {
		await expect(call("settings", { branch_rules: [{ pattern: "feature/*" }] })).rejects.toThrow(/changes nothing/);
		await expect(call("settings", { branch_rules: [{ pattern: "feature x", required: 0 }] })).rejects.toThrow(/pattern is a branch name/);
		// [] clears them.
		await call("settings", { branch_rules: [{ pattern: "feature/*", required: 0 }] });
		expect(await call("settings", { branch_rules: [] })).not.toHaveProperty("branchRules");
	});
});
