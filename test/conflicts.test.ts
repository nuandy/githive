import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUNK_BYTES, HUNK_FILES, Workspace } from "../src/git";
import { statusOf } from "../src/errors";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { BATCH_MERGE } from "../src/toolkit/merge-checks";
import type { CheckRunner } from "../src/toolkit/merge";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";
import { toolCalls } from "./helpers/tool-calls";

// Conflicts that explain themselves: who changed each conflicted file since the change left the branch, the files
// with their conflict markers, and commands that resolve it in the agent's own clone. Each conflict and failed check
// is noted as an attempt for the merge commit's story.

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-conflicts-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

// Asynchronously: the test's git servers run in this process, so a blocking call would wait on itself.
const run = promisify(execFile);
const identity = { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" };
const shell = async (directory: string, command: string) =>
	(await run("bash", ["-c", command], { cwd: directory, env: { ...process.env, ...identity } })).stdout;

/** A commit on main with `files`, pushed with plain git by `who`. */
async function pushToMain(who: string, files: Record<string, string>, message = "edit") {
	const clone = await agentClone(server.url, work, `${who}-${Math.random().toString(36).slice(2, 6)}`);
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", message);
	await clone.run("push", "--quiet", "origin", "main");
	return server.git("rev-parse", "main").trim();
}

describe("a test merge's conflict markers", { timeout: 60_000 }, () => {
	it("caps hunks at 4 KB and marks them truncated", async () => {
		const remote = { url: server.url, token: "unused" };
		const lines = (tag: string) => Array.from({ length: 300 }, (_, k) => `${tag} café line ${k}\n`).join("");
		// Ten small files and one large one, all changed on both sides.
		const small = Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`f${k}.txt`, `${k}\n`]));
		const base = await pushToMain("seed", { ...small, "big.txt": lines("base") });
		const change = await pushChange(
			server.url,
			work,
			"agent-a",
			"a-1",
			{ ...Object.fromEntries(Object.keys(small).map((file) => [file, "a\n"])), "big.txt": lines("a") },
			base,
		);
		const main = await pushToMain("main", {
			...Object.fromEntries(Object.keys(small).map((file) => [file, "main\n"])),
			"big.txt": lines("main"),
		});
		const workspace = await Workspace.at(remote, "main", main);
		const head = await workspace.fetch("change", remote, "changes/a-1");
		expect(head).toBe(change);
		const tried = await workspace.tryMerge(main, head, { ours: "main", theirs: "changes/a-1" });
		if (tried.clean) throw new Error("expected a conflict");
		expect(tried.files).toHaveLength(11);
		// At most HUNK_FILES files, each with its markers.
		expect(tried.hunks).toHaveLength(HUNK_FILES);
		const big = tried.hunks!.find((hunk) => hunk.file === "big.txt")!;
		expect(big.truncated).toBe(true);
		expect(Buffer.byteLength(big.content)).toBeLessThanOrEqual(HUNK_BYTES);
		expect(big.content).toMatch(/^@@ line 1 @@\n<<<<<<< main\nmain café line 0\n/);
		// Cut at the start of a character, never inside one.
		expect(big.content).not.toContain("�");
		const one = tried.hunks!.find((hunk) => hunk.file === "f0.txt");
		expect(one).toEqual({
			file: "f0.txt",
			content: "<<<<<<< main\nmain\n=======\na\n>>>>>>> changes/a-1\n",
			truncated: false,
		});
	});
});

describe("fixing a conflict", { timeout: 60_000 }, () => {
	let fork: GitServer;
	beforeEach(async () => {
		fork = await startGitServer();
		// A fork starts as a copy of the project.
		const seed = await agentClone(server.url, work, "seed");
		await seed.run("push", "--quiet", "--force", fork.url, "main");
	});
	afterEach(async () => {
		await fork.close();
	});

	const ctx = (agentKey?: string): ToolContext => ({
		remote: async (_repo, scope) => ({ url: server.url, token: scope }),
		batchGit: () => memoryBatchGit({ url: server.url, token: "write" }),
		changeRemote: async (_repo, _agent, scope) => ({ url: fork.url, token: `fork-${scope}` }),
		head: async () => server.git("rev-parse", "main").trim(),
		...(agentKey ? { agentKey } : {}),
	});
	const call = async (name: string, args: Record<string, unknown>, agentKey?: string) => {
		try {
			return (await callTool(name, { repo: "project", ...args }, ctx(agentKey))) as Record<string, unknown>;
		} catch (err) {
			return { error: statusOf(err).message };
		}
	};

	it("gives commands that resolve the conflict when run in the agent's clone", async () => {
		await call("settings", {});
		const { key } = (await call("register", { agent: "agent-a" })) as { key: string };
		await call("claim", { change: "a-1", agent: "agent-a", paths: ["src/"], intent: "a" }, key);
		const own = (await call("credentials", { change: "a-1" }, key)) as { git: { setup: string[]; push: string } };
		const author = mkdtempSync(join(work, "author-"));
		await shell(author, own.git.setup.join(" && "));
		const clone = join(author, "a-1");
		writeFileSync(join(clone, "shared.txt"), "a's line\n");
		await shell(clone, `git add shared.txt && git commit -qm a && ${own.git.push}`);
		// Meanwhile someone changed the same file on the project's main.
		await pushToMain("mainline", { "shared.txt": "main's line\n" }, "main's change");

		const before = (await call("status", { change: "a-1" }, key)) as { merge: { clean: boolean; fix: string[] } };
		expect(before.merge).toMatchObject({ clean: false, conflicts: ["shared.txt"] });
		const [merge, resolve, commit, push, then] = before.merge.fix;
		expect(resolve).toBe("# resolve shared.txt so both changes make sense, then:");
		expect(then).toBe("call status; once the new commit is approved, merge again");
		// Merging the branch in stops at the conflict, for the agent to resolve.
		await expect(shell(clone, merge!)).rejects.toThrow();
		writeFileSync(join(clone, "shared.txt"), "main's line\na's line\n");
		await shell(clone, commit!);
		await shell(clone, push!);

		const after = (await call("status", { change: "a-1" }, key)) as { merge: Record<string, unknown> };
		expect(after.merge).toMatchObject({ clean: true });
		expect(after.merge).not.toHaveProperty("conflicts");
		expect(fork.git("show", "changes/a-1:shared.txt")).toBe("main's line\na's line\n");
	});
});

describe("attempts at landing", { timeout: 60_000 }, () => {
	const noted: [string, string, string][] = [];
	const pings: unknown[] = [];
	const results: Record<string, { command: string; exitCode: number; output: string }> = {};
	const runChecks: CheckRunner = async ({ changes }) => {
		const failed = changes.map((change) => results[change.change]).find(Boolean);
		return { passed: !failed, results: [failed ?? { command: "npm test", exitCode: 0, output: "ok" }] };
	};
	const { call, register, approve } = toolCalls(() => server, {
		runChecks: () => runChecks,
		noteAttempt: async (repo, change, line) => void noted.push([repo, change, line]),
		ping: async (_repo, event) => void pings.push(event),
	});
	beforeEach(async () => {
		noted.length = 0;
		pings.length = 0;
		for (const change of Object.keys(results)) delete results[change];
		await call("settings", { required: 1, vetoes: [], verify: ["npm test"] });
		await register("a", "b", "reviewer");
	});
	async function approved(agent: string, change: string, files: Record<string, string>, from?: string) {
		await call("claim", { change, agent, paths: Object.keys(files), intent: `${change}'s intent` }, agent);
		const head = await pushChange(server.url, work, agent, change, files, from);
		await approve(head);
		return head;
	}

	it("notes an attempt for a conflict and for failed checks", async () => {
		const base = server.git("rev-parse", "main").trim();
		await approved("a", "a-1", { "shared.txt": "a\n" });
		expect(await call("merge", { change: "a-1", agent: "a" }, "a")).toMatchObject({ ok: true });
		const landed = server.git("rev-parse", "main").trim();
		// b-1 left main before a-1 landed, and changed the same file.
		await approved("b", "b-1", { "shared.txt": "b\n" }, base);
		expect(await call("merge", { change: "b-1", agent: "b" }, "b")).toMatchObject({ ok: false });
		const conflict = `conflict on shared.txt with a-1 by a ("a-1's intent", ${landed.slice(0, 7)})`;
		expect(noted).toEqual([["p", "b-1", conflict]]);
		// The hive sees the conflict, naming its file.
		expect(pings).toContainEqual(
			expect.objectContaining({ kind: "conflicted", agent: "b", change: "b-1", detail: "shared.txt" }),
		);
		// b gives it up, so later batches don't take it in.
		await call("release", { change: "b-1", agent: "b" }, "b");

		// Failed checks are an attempt too, and so is a batch the Gate couldn't merge, in the words it gave.
		results["c-1"] = { command: "npm test", exitCode: 1, output: "1 failing" };
		await approved("a", "c-1", { "c.txt": "c\n" });
		expect(await call("merge", { change: "c-1", agent: "a" }, "a")).toMatchObject({
			ok: false,
			reasons: ["checks failed: npm test exited 1"],
		});
		const gateSaid = 'conflict on d.txt with c-7 by alice ("add refunds", 6584265)';
		results["d-1"] = { command: BATCH_MERGE, exitCode: 1, output: gateSaid };
		await approved("a", "d-1", { "d.txt": "d\n" });
		expect(await call("merge", { change: "d-1", agent: "a" }, "a")).toMatchObject({ ok: false, reasons: [gateSaid] });
		expect(noted.slice(1)).toEqual([
			["p", "c-1", "checks failed: npm test exited 1"],
			["p", "d-1", gateSaid],
		]);
	});
});
