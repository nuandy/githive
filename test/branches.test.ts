import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimInto,
	isReservedPath,
	presentClaim,
	scopeFile,
	scopePaths,
	unscopePath,
} from "../src/toolkit/branch-scope";
import { callTool, makeBranch, mergeAsPerson, repoSnapshot, type ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// Changes land on the project's branch, or on another their claim names
// (`into`). Claims are per branch: the same paths on two branches don't
// conflict. A missing branch is made only when the claim says what from.

describe("claims kept per branch", () => {
	it("keep another branch's paths under a part of their own, and give them back as agents gave them", () => {
		expect(scopePaths(["lib/"], "main", "main")).toEqual(["lib/"]);
		const scoped = scopePaths(["lib/auth/", "README.md"], "release/2.x", "main");
		expect(scoped).toEqual(["::release%2F2.x/lib/auth/", "::release%2F2.x/README.md"]);
		expect(scoped.every(isReservedPath)).toBe(true);
		expect(unscopePath(scoped[0]!, "main")).toEqual({ into: "release/2.x", path: "lib/auth/" });
		expect(unscopePath("lib/auth/", "main")).toEqual({ into: "main", path: "lib/auth/" });
		expect(claimInto({ paths: scoped }, "main")).toBe("release/2.x");
		expect(presentClaim({ change: "c", paths: scoped }, "main")).toEqual({
			change: "c",
			paths: ["lib/auth/", "README.md"],
			into: "release/2.x",
		});
		expect(scopeFile("lib/auth/x.js", "release/2.x", "main")).toBe("::release%2F2.x/lib/auth/x.js");
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
const call = (name: string, args: Record<string, unknown>, as?: string) =>
	callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;
const tip = (branch: string) => server.git("rev-parse", branch).trim();

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-branches-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe.each([
	["kept in one record", undefined],
	["sharded", 2],
])("with claims %s", (_mode, shardDepth) => {
	beforeEach(async () => {
		await call("settings", { required: 1, vetoes: [], ...(shardDepth ? { shard_depth: shardDepth } : {}) });
		for (const agent of ["a", "b", "reviewer"])
			keys[agent] = ((await call("register", { agent })) as { key: string }).key;
	});

	describe("a change into another branch", () => {
		it("needs from to make a branch that doesn't exist, so a misspelt name is refused, not made", async () => {
			await expect(
				call("claim", { change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude" }, "a"),
			).rejects.toThrow(/feature\/dude doesn't exist: claim again with from/);
			expect(server.git("branch", "--list", "feature/dude").trim()).toBe("");
		});

		it("makes the branch from `from`, and says so", async () => {
			const claimed = await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			expect(claimed).toMatchObject({
				ok: true,
				into: "feature/dude",
				branch: expect.stringContaining("made feature/dude from main"),
			});
			expect(tip("feature/dude")).toBe(tip("main"));
		});

		it("holds its paths on that branch only: the same paths on the project's branch are free", async () => {
			await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			expect(await call("claim", { change: "m1", agent: "b", paths: ["src/f/"], intent: "m" }, "b")).toMatchObject({
				ok: true,
			});
			// On the same branch they conflict, named as agents gave them.
			expect(
				await call(
					"claim",
					{ change: "f2", agent: "b", paths: ["src/f/x.js"], intent: "f2", into: "feature/dude" },
					"b",
				),
			).toMatchObject({ ok: false, conflicts: [{ change: "f1", held: "src/f/" }] });
			const claims = (await call("claims", {})) as unknown as { change: string; paths: string[]; into?: string }[];
			expect(claims.map((c) => [c.change, c.paths, c.into])).toEqual([
				["f1", ["src/f/"], "feature/dude"],
				["m1", ["src/f/"], undefined],
			]);
		});

		it("lands on one branch: claiming it again into another is refused", async () => {
			await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			await expect(
				call("claim", { change: "f1", agent: "a", paths: ["src/g/"], intent: "f", into: "main" }, "a"),
			).rejects.toThrow(/f1 lands on feature\/dude/);
			// Claiming again without into keeps it where it lands.
			expect(await call("claim", { change: "f1", agent: "a", paths: ["src/g/"], intent: "f" }, "a")).toMatchObject({
				ok: true,
				into: "feature/dude",
			});
		});

		it("starts from that branch, is checked against and merged onto it, leaving the project's branch alone", async () => {
			await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			expect(await call("credentials", { change: "f1" }, "a")).toMatchObject({
				into: "feature/dude",
				project: { branch: "feature/dude" },
			});
			const head = await pushChange(server.url, work, "a", "f1", { "src/f/x.js": "x\n" }, "origin/feature/dude");
			expect(await call("status", { change: "f1" }, "a")).toMatchObject({
				merge: { into: "feature/dude", clean: true, outsideClaim: [] },
			});
			await call(
				"vote",
				{ commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" },
				"reviewer",
			);
			const main = tip("main");
			const merged = await call("merge", { change: "f1", agent: "a" }, "a");
			expect(merged).toMatchObject({ ok: true });
			expect(server.git("log", "-1", "--format=%P", "feature/dude").trim().split(" ")).toEqual([main, head]);
			expect(tip("main")).toBe(main);
			// The audit reads the branch too, and finds nothing wrong.
			expect(await call("audit", {})).toMatchObject({ merges: 1, open: 0 });
		});

		it("can't touch files outside its claim on that branch", async () => {
			await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			const head = await pushChange(
				server.url,
				work,
				"a",
				"f1",
				{ "src/f/x.js": "x\n", "README.md": "changed\n" },
				"origin/feature/dude",
			);
			await call(
				"vote",
				{ commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" },
				"reviewer",
			);
			expect(await call("merge", { change: "f1", agent: "a" }, "a")).toMatchObject({
				ok: false,
				reasons: [expect.stringContaining("README.md is outside f1's claim")],
			});
		});

		it("adopts a branch that's there already, as it is", async () => {
			server.git("branch", "release/2.x", "main");
			expect(
				await call("claim", { change: "r1", agent: "a", paths: ["src/r/"], intent: "r", into: "release/2.x" }, "a"),
			).toMatchObject({
				ok: true,
				into: "release/2.x",
				branch: expect.stringContaining("changes land on release/2.x from now on"),
			});
		});

		it("never lets an agent claim in a branch's part of the records itself", async () => {
			await expect(
				call("claim", { change: "x", agent: "a", paths: ["::feature%2Fdude/src/"], intent: "x" }, "a"),
			).rejects.toThrow(/can't start with "::"/);
		});
	});

	describe("people, from the dashboard", () => {
		it("make a branch from another, and see it, with what each change waits on, in the snapshot", async () => {
			expect(
				await makeBranch(ctx(), "p", { name: "release/2.x", from: "main" }, "person:ada@example.com"),
			).toMatchObject({ name: "release/2.x", made: expect.stringContaining("made release/2.x from main") });
			expect(tip("release/2.x")).toBe(tip("main"));
			await expect(
				makeBranch(ctx(), "p", { name: "release/2.x", from: "main" }, "person:ada@example.com"),
			).rejects.toThrow(/takes changes already/);
			await call(
				"claim",
				{ change: "fix", agent: "a", paths: ["src/f/"], intent: "fix", into: "release/2.x", after: ["other"] },
				"a",
			);
			const snapshot = await repoSnapshot(ctx(), "p");
			expect(snapshot.branches).toEqual([expect.objectContaining({ name: "release/2.x", from: "main" })]);
			expect(snapshot.claims).toEqual([
				expect.objectContaining({ change: "fix", into: "release/2.x", paths: ["src/f/"], waitsOn: ["other"] }),
			]);
		});

		it("merge an approved change, through the same merge an agent asks for", async () => {
			await call(
				"claim",
				{ change: "f1", agent: "a", paths: ["src/f/"], intent: "f", into: "feature/dude", from: "main" },
				"a",
			);
			const head = await pushChange(server.url, work, "a", "f1", { "src/f/x.js": "x\n" }, "origin/feature/dude");
			await expect(mergeAsPerson(ctx(), "p", "f1", "agent-b")).rejects.toThrow(/only a person/);
			expect(await mergeAsPerson(ctx(), "p", "f1", "person:ada@example.com")).toMatchObject({
				ok: false,
				reasons: [expect.stringContaining("0 of 1 approvals")],
			});
			await call(
				"vote",
				{ commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" },
				"reviewer",
			);
			expect(await mergeAsPerson(ctx(), "p", "f1", "person:ada@example.com")).toMatchObject({ ok: true });
			expect(server.git("log", "-1", "--format=%P", "feature/dude").trim().split(" ")).toContain(head);
		});
	});
});
