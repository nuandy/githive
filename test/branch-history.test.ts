import { mkdtempSync, rmSync, unlinkSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HistorySource, readBranchHistory } from "../src/toolkit/branch-history";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The audit reads a branch's history through Artifacts' API: log for the
// first-parent chain, and readTree to work out what each commit changed from its
// first parent. The result must match git exactly. Here git on a test server
// answers as Artifacts would, and git diff-tree is the reference.

/** Artifacts' log, readCommit and readTree, answered by git on the server. */
export function gitHistory(server: GitServer): HistorySource {
	const FORMAT = "--format=%H%x1f%T%x1f%an%x1f%P%x1f%B%x1e";
	const meta = (line: string) => {
		const [hash, treeHash, name, parents, message] = line.split("\x1f") as [string, string, string, string, string];
		return {
			hash,
			treeHash,
			author: { name },
			parents: parents.split(" ").filter(Boolean),
			message: message.replace(/\n$/, ""),
		};
	};
	return {
		log: async (ref, limit, offset) =>
			server
				.git("log", "--first-parent", `--skip=${offset}`, `-n${limit}`, FORMAT, ref)
				.split("\x1e")
				.map((l) => l.replace(/^\n/, ""))
				.filter(Boolean)
				.map(meta),
		readCommit: async (hash) => meta(server.git("log", "-1", FORMAT, hash).split("\x1e")[0]!),
		readTree: async (hash) =>
			server
				.git("ls-tree", hash)
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [info, name] = l.split("\t") as [string, string];
					const [mode, type, oid] = info.split(" ") as [string, string, string];
					return { name, mode, hash: oid, type: type === "commit" ? "gitlink" : type };
				}),
	};
}

describe("a branch's history through Artifacts' API", { timeout: 60_000 }, () => {
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

	it("lists what git diff-tree does: added, deleted, mode changed, a folder replaced by a file and back", async () => {
		const baseline = server.git("rev-parse", "main").trim();
		const clone = await agentClone(server.url, work, "author");
		const dir = join(work, "author");
		const commit = async (message: string, change: () => void) => {
			change();
			await clone.run("add", "-A");
			await clone.run("commit", "-q", "-m", message);
		};
		await commit("add", () => {
			clone.write("a.txt", "a\n");
			clone.write("tool.sh", "echo\n");
			clone.write("d/x.txt", "x\n");
			clone.write("d/deep/y.txt", "y\n");
		});
		await commit("delete and modify", () => {
			unlinkSync(join(dir, "a.txt"));
			clone.write("d/deep/y.txt", "y, again\n");
		});
		await commit("executable", () => chmodSync(join(dir, "tool.sh"), 0o755));
		await commit("a folder becomes a file", () => {
			rmSync(join(dir, "d"), { recursive: true });
			writeFileSync(join(dir, "d"), "now a file\n");
		});
		await commit("and back", () => {
			unlinkSync(join(dir, "d"));
			mkdirSync(join(dir, "d"));
			writeFileSync(join(dir, "d", "z.txt"), "z\n");
		});
		await clone.run("push", "-q", "origin", "HEAD:main");
		const read = await readBranchHistory(gitHistory(server), baseline, "main");
		expect(read.map((c) => c.message)).toEqual([
			"add",
			"delete and modify",
			"executable",
			"a folder becomes a file",
			"and back",
		]);
		for (const c of read)
			expect(c.files).toEqual(
				server
					.git("diff-tree", "--no-commit-id", "--name-only", "-r", c.parents[0]!, c.commit)
					.split("\n")
					.filter(Boolean)
					.sort(),
			);
		expect(read.map((c) => c.files)).toEqual([
			["a.txt", "d/deep/y.txt", "d/x.txt", "tool.sh"],
			["a.txt", "d/deep/y.txt"],
			["tool.sh"],
			["d", "d/deep/y.txt", "d/x.txt"],
			["d", "d/z.txt"],
		]);
	});

	it("reads a long history in pages, and nothing before the baseline", async () => {
		const clone = await agentClone(server.url, work, "author");
		for (let i = 0; i < 5; i++) {
			clone.write(`f${i}.txt`, `${i}\n`);
			await clone.run("add", "-A");
			await clone.run("commit", "-q", "-m", `c${i}`);
		}
		await clone.run("push", "-q", "origin", "HEAD:main");
		const baseline = server.git("rev-parse", "main~3").trim();
		// Pages hold two commits even though more were asked for. A short page isn't the end; reading goes on to the
		// baseline.
		const source = gitHistory(server);
		const pages: number[] = [];
		const paged: HistorySource = {
			...source,
			log: async (ref, _limit, offset) => (pages.push(offset), source.log(ref, 2, offset)),
		};
		const read = await readBranchHistory(paged, baseline, "main");
		expect(read.map((c) => c.message)).toEqual(["c2", "c3", "c4"]);
		expect(read.map((c) => c.files)).toEqual([["f2.txt"], ["f3.txt"], ["f4.txt"]]);
		expect(pages).toEqual([0, 2]);
	});
});
