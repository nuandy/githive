import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	artifactsInspect,
	changeAgainst,
	forgetChains,
	type Placed,
	type ReadHistory,
	type SharedPlacements,
} from "../src/toolkit/batch-reads";
import type { CommitMeta, HistorySource, TreeEntry } from "../src/toolkit/branch-history";
import { agentClone, pushChange } from "./helpers/agents";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// Repos as Artifacts' API reads them: each a log per ref (first parents, newest first) and the trees.
const blob = (name: string, hash: string): TreeEntry => ({ name, mode: "100644", hash, type: "blob" });
const commit = (hash: string, parents: string[]): CommitMeta => ({
	hash,
	treeHash: `t-${hash}`,
	message: hash,
	author: { name: "a" },
	parents,
});

const trees: Record<string, TreeEntry[]> = {
	"t-m1": [blob("a.txt", "a1"), blob("b.txt", "b1")],
	"t-m2": [blob("a.txt", "a2"), blob("b.txt", "b1")],
	"t-m3": [blob("a.txt", "a3"), blob("b.txt", "b1")],
	// The change's own work: c.txt, and b.txt.
	"t-c1": [blob("a.txt", "a1"), blob("b.txt", "b1"), blob("c.txt", "c1")],
	"t-c2": [blob("a.txt", "a1"), blob("b.txt", "b2"), blob("c.txt", "c1")],
	// main (m2) merged in: a.txt as main has it.
	"t-c3": [blob("a.txt", "a2"), blob("b.txt", "b2"), blob("c.txt", "c1")],
	"t-x1": [blob("a.txt", "a1"), blob("x.txt", "x1")],
};
const main = [commit("m3", ["m2"]), commit("m2", ["m1"]), commit("m1", ["m0"])];

function repos(logs: Record<string, Record<string, CommitMeta[]>>): { history: ReadHistory; reads: string[] } {
	const reads: string[] = [];
	const source = (repo: string): HistorySource => ({
		log: async (ref, limit, offset) => (
			reads.push(`${repo} log ${ref}${limit === 1 ? " head" : ""}`),
			(logs[repo]?.[ref] ?? []).slice(offset, offset + limit)
		),
		readCommit: async () => null,
		readTree: async (hash) => (reads.push(`${repo} tree ${hash}`), trees[hash] ?? null),
	});
	return { history: (repo, read) => read(source(repo)), reads };
}

const fork = { url: "https://git.test/ns/fork--proj--agent--a.git", token: "t" };
// Chains are cached per isolate by repo name, so each test starts with a fresh
// "proj".
beforeEach(() => forgetChains());
const change = (name: string) => ({ change: name, ref: `changes/${name}`, source: fork, agent: "a" });

describe("a batch read through Artifacts' API", () => {
	it("gives a change's head and the files it changed since it left main, asking the Gate nothing", async () => {
		const { history } = repos({
			proj: { main },
			"fork--proj--agent--a": { "changes/one": [commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)] },
		});
		const gate = vi.fn();
		const read = await artifactsInspect(
			history,
			"proj",
			gate,
		)({ base: "m3", branch: "main", changes: [change("one")] });
		expect(read).toEqual([{ change: "one", head: "c2", files: ["b.txt", "c.txt"] }]);
		expect(gate).not.toHaveBeenCalled();
	});

	it("counts from the newest main commit the change merged in, as git's merge-base does", async () => {
		const { history } = repos({
			proj: { main },
			"fork--proj--agent--a": {
				"changes/one": [commit("c3", ["c2", "m2"]), commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)],
			},
		});
		const read = await artifactsInspect(
			history,
			"proj",
			vi.fn(),
		)({ base: "m3", branch: "main", changes: [change("one")] });
		// a.txt came from main (m2), not from the change.
		expect(read).toEqual([{ change: "one", head: "c3", files: ["b.txt", "c.txt"] }]);
	});

	it("reads main from where the batch is, though main moved on since", async () => {
		const { history } = repos({
			proj: { main: [commit("m4", ["m3"]), ...main] },
			"fork--proj--agent--a": { "changes/one": [commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)] },
		});
		const read = await artifactsInspect(
			history,
			"proj",
			vi.fn(),
		)({ base: "m3", branch: "main", changes: [change("one")] });
		expect(read).toEqual([{ change: "one", head: "c2", files: ["b.txt", "c.txt"] }]);
	});

	it("has the Gate read a change that merged in something other than main, and only that one", async () => {
		const { history } = repos({
			proj: { main },
			"fork--proj--agent--a": {
				"changes/one": [commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)],
				"changes/two": [commit("y1", ["c1", "x1"]), commit("c1", ["m1"]), ...main.slice(2)],
			},
		});
		const gate = vi.fn(async ({ changes }: { changes: { change: string }[] }) =>
			changes.map((c) => ({ change: c.change, head: "in-the-gate", files: ["by-git"] })),
		);
		const read = await artifactsInspect(
			history,
			"proj",
			gate,
		)({ base: "m3", branch: "main", changes: [change("one"), change("two")] });
		expect(read).toEqual([
			{ change: "one", head: "c2", files: ["b.txt", "c.txt"] },
			{ change: "two", head: "in-the-gate", files: ["by-git"] },
		]);
		expect(gate.mock.calls[0]![0].changes.map((c) => c.change)).toEqual(["two"]);
	});

	it("has the Gate read them all when main's history doesn't reach the batch's base", async () => {
		const { history } = repos({ proj: { main }, "fork--proj--agent--a": {} });
		const gate = vi.fn(async () => []);
		await artifactsInspect(history, "proj", gate)({ base: "elsewhere", branch: "main", changes: [change("one")] });
		expect(gate).toHaveBeenCalledTimes(1);
	});

	it("says a change's branch couldn't be read when its fork has none", async () => {
		const { history } = repos({ proj: { main }, "fork--proj--agent--a": {} });
		const read = await artifactsInspect(
			history,
			"proj",
			vi.fn(),
		)({ base: "m3", branch: "main", changes: [change("one")] });
		expect(read).toEqual([{ change: "one", error: "its branch couldn't be read" }]);
	});

	it("reads only the folders that differ", async () => {
		const { history, reads } = repos({
			proj: { main },
			"fork--proj--agent--a": { "changes/one": [commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)] },
		});
		await artifactsInspect(history, "proj", vi.fn())({ base: "m3", branch: "main", changes: [change("one")] });
		expect(reads.filter((r) => r.includes(" tree "))).toEqual([
			"fork--proj--agent--a tree t-m1",
			"fork--proj--agent--a tree t-c2",
		]);
	});

	describe("with places kept by other Worker instances", () => {
		const kept = () => {
			const store = new Map<string, Placed>();
			const shared: SharedPlacements = {
				read: async (branch, heads) =>
					Object.fromEntries(
						heads.flatMap((head) => store.get(`${branch}|${head}`) ?? []).map((p) => [p.head.hash, p]),
					),
				keep: async (branch, placed) => {
					for (const each of placed) store.set(`${branch}|${each.head.hash}`, each);
				},
			};
			return { store, shared };
		};
		const forkLog = [commit("c2", ["c1"]), commit("c1", ["m1"]), ...main.slice(2)];

		it("reads only a change's head when another instance placed it as it was seen", async () => {
			const { store, shared } = kept();
			const placing = repos({ proj: { main }, "fork--proj--agent--a": { "changes/one": forkLog } });
			await artifactsInspect(
				placing.history,
				"proj",
				vi.fn(),
				shared,
			)({
				base: "m3",
				branch: "main",
				changes: [change("one")],
			});
			expect([...store.keys()]).toEqual(["main|c2"]);
			// Another isolate, which has placed nothing itself.
			forgetChains();
			const { history, reads } = repos({ proj: { main }, "fork--proj--agent--a": { "changes/one": forkLog } });
			const read = await artifactsInspect(
				history,
				"proj",
				vi.fn(),
				shared,
			)({
				base: "m3",
				branch: "main",
				changes: [{ ...change("one"), seen: "c2" }],
			});
			expect(read).toEqual([{ change: "one", head: "c2", files: ["b.txt", "c.txt"] }]);
			expect(reads.filter((r) => r.startsWith("fork"))).toEqual(["fork--proj--agent--a log changes/one head"]);
		});

		it("reads a change again in full when its head moved since it was seen", async () => {
			const { shared } = kept();
			const placing = repos({ proj: { main }, "fork--proj--agent--a": { "changes/one": forkLog.slice(1) } });
			await artifactsInspect(
				placing.history,
				"proj",
				vi.fn(),
				shared,
			)({
				base: "m3",
				branch: "main",
				changes: [change("one")],
			});
			forgetChains();
			const { history } = repos({ proj: { main }, "fork--proj--agent--a": { "changes/one": forkLog } });
			const read = await artifactsInspect(
				history,
				"proj",
				vi.fn(),
				shared,
			)({
				base: "m3",
				branch: "main",
				changes: [{ ...change("one"), seen: "c1" }],
			});
			expect(read).toEqual([{ change: "one", head: "c2", files: ["b.txt", "c.txt"] }]);
		});
	});
});

describe("a change against main through Artifacts' API", () => {
	const trees2: Record<string, TreeEntry[]> = {
		...trees,
		// main moved on from m1 in b.txt (m4), or replaced the folder lib with a file (m5).
		"t-m4": [blob("a.txt", "a1"), blob("b.txt", "b9")],
		"t-m5": [blob("a.txt", "a1"), blob("b.txt", "b1"), blob("lib", "l0")],
		"t-c5": [blob("a.txt", "a1"), blob("b.txt", "b1"), { name: "lib", mode: "040000", hash: "t-lib", type: "tree" }],
		"t-lib": [blob("x.js", "x1")],
	};
	const repos2 =
		(logs: Record<string, Record<string, CommitMeta[]>>): ReadHistory =>
		(repo, read) =>
			read({
				log: async (ref, limit, offset) => (logs[repo]?.[ref] ?? []).slice(offset, offset + limit),
				readCommit: async () => null,
				readTree: async (hash) => trees2[hash] ?? null,
			});
	const m1 = commit("m1", ["m0"]);

	it("finds no file changed on both sides when main moved elsewhere", async () => {
		const history = repos2({
			proj: { main: [commit("m2", ["m1"]), m1] },
			"fork--proj--agent--a": { "changes/one": [commit("c1", ["m1"]), m1] },
		});
		expect(await changeAgainst(history, "proj", "main", "m2", { ref: "changes/one", source: fork })).toEqual({
			head: "c1",
			files: ["c.txt"],
			both: [],
		});
	});

	it("names a file both changed", async () => {
		const history = repos2({
			proj: { main: [commit("m4", ["m1"]), m1] },
			"fork--proj--agent--a": { "changes/one": [commit("c2", ["c1"]), commit("c1", ["m1"]), m1] },
		});
		expect(await changeAgainst(history, "proj", "main", "m4", { ref: "changes/one", source: fork })).toEqual({
			head: "c2",
			files: ["b.txt", "c.txt"],
			both: ["b.txt"],
		});
	});

	it("counts a folder one side replaced with a file as changed on both", async () => {
		const history = repos2({
			proj: { main: [commit("m5", ["m1"]), m1] },
			"fork--proj--agent--a": { "changes/one": [commit("c5", ["m1"]), m1] },
		});
		expect(await changeAgainst(history, "proj", "main", "m5", { ref: "changes/one", source: fork })).toEqual({
			head: "c5",
			files: ["lib/x.js"],
			both: ["lib/x.js"],
		});
	});

	it("can't place a change that merged in something other than main, or says its branch can't be read", async () => {
		const history = repos2({
			proj: { main: [m1] },
			"fork--proj--agent--a": { "changes/one": [commit("y1", ["m1", "x1"]), m1] },
		});
		expect(await changeAgainst(history, "proj", "main", "m1", { ref: "changes/one", source: fork })).toBeNull();
		expect(await changeAgainst(history, "proj", "main", "m1", { ref: "changes/none", source: fork })).toEqual({
			error: "its branch couldn't be read",
		});
	});
});

describe("the branch's history, kept for the isolate", () => {
	it("is read once per head of main, then only the commits on top as main moves", async () => {
		const logs: { ref: string; limit: number }[] = [];
		let main = [commit("m3", ["m2"]), commit("m2", ["m1"]), commit("m1", ["m0"])];
		const history: ReadHistory = (repo, read) =>
			read({
				log: async (ref, limit, offset) => (
					logs.push({ ref, limit }),
					(repo === "proj" ? main : [commit("c1", ["m1"]), commit("m1", ["m0"])]).slice(offset, offset + limit)
				),
				readCommit: async () => null,
				readTree: async (hash) => trees[hash] ?? [],
			});
		const project = () => logs.filter((l) => l.ref === "main").map((l) => l.limit);
		await changeAgainst(history, "proj", "main", "m3", { ref: "changes/one", source: fork });
		await changeAgainst(history, "proj", "main", "m3", { ref: "changes/one", source: fork });
		// A caller whose head is slightly behind finds it on the cached chain, so nothing is read.
		await changeAgainst(history, "proj", "main", "m2", { ref: "changes/one", source: fork });
		expect(project()).toEqual([1000]);
		// When main moves on, only the page on top is read.
		main = [commit("m4", ["m3"]), ...main];
		expect(await changeAgainst(history, "proj", "main", "m4", { ref: "changes/one", source: fork })).toMatchObject({
			head: "c1",
		});
		expect(project()).toEqual([1000, 64]);
	});
});

describe("a batch read through Artifacts' API, against git itself", () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-reads-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("reads what git's merge-base says, for a change that merged main in and one that didn't", async () => {
		const remote = { url: server.url, token: "t" };
		await pushChange(server.url, work, "a", "one", { "src/one/a.ts": "a" });
		// main moves on (another change landed), and "two" merges it in on top of its own work.
		const lander = await agentClone(server.url, work, "lander");
		lander.write("src/landed/x.ts", "x");
		await lander.run("add", "-A");
		await lander.run("commit", "--quiet", "-m", "landed");
		await lander.run("push", "--quiet", "origin", "main");
		const two = await agentClone(server.url, work, "b");
		await two.run("checkout", "--quiet", "-b", "changes/two", "HEAD~1");
		two.write("src/two/b.ts", "b");
		await two.run("add", "-A");
		await two.run("commit", "--quiet", "-m", "two: work");
		await two.run("merge", "--quiet", "--no-edit", "origin/main");
		two.write("src/two/c.ts", "c");
		await two.run("add", "-A");
		await two.run("commit", "--quiet", "-m", "two: more");
		await two.run("push", "--quiet", "origin", "changes/two");
		const base = server.git("rev-parse", "main").trim();
		const changes = ["one", "two"].map((change) => ({ change, ref: `changes/${change}`, agent: "a" }));
		const gate = vi.fn(memoryBatchGit(remote).inspect);
		const read = await artifactsInspect(gitHistory(server.git), "project", gate)({ base, branch: "main", changes });
		expect(gate).not.toHaveBeenCalled();
		// What git reads, fetching the changes (as the Gate does).
		expect(read).toEqual(await memoryBatchGit(remote).inspect({ base, branch: "main", changes }));
		expect(read).toEqual([
			{ change: "one", head: server.git("rev-parse", "changes/one").trim(), files: ["src/one/a.ts"] },
			{ change: "two", head: server.git("rev-parse", "changes/two").trim(), files: ["src/two/b.ts", "src/two/c.ts"] },
		]);
	});
});
