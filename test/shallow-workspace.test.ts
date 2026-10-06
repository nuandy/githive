import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/git";
import { readMainMerges } from "../src/free/git-records";
import { startGitServer, type GitServer } from "./helpers/git-server";

// A project's whole history may not fit in a Durable Object's memory, so a
// workspace starts shallow and fetches older commits only when Git needs them.
// Here the history is 40 commits and the workspace starts with 2.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });
const git = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]).toString().trim();

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "shallow-"));
	// Build the history by path: git over HTTP would wait on this process's own server.
	const repos = join(server.git("rev-parse", "--absolute-git-dir").trim(), "..");
	execFileSync("git", ["clone", "--quiet", join(repos, "project.git"), work]);
	for (let i = 0; i < 40; i++) {
		writeFileSync(join(work, `file${i % 5}.txt`), `${i}\n`);
		git("add", "-A");
		git("commit", "--quiet", "-m", `commit ${i}`);
		// A change that branched off early, on its own branch.
		if (i === 2) {
			git("checkout", "--quiet", "-b", "changes/early");
			writeFileSync(join(work, "early.txt"), "early\n");
			git("add", "early.txt");
			git("commit", "--quiet", "-m", "early change");
			git("checkout", "--quiet", "main");
		}
	}
	git("push", "--quiet", "origin", "main", "changes/early");
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a shallow workspace", () => {
	it("deepens to find the merge base of a change that branched off long ago, then merges it", async () => {
		const ws = await Workspace.clone(remote(), "main", { depth: 2 });
		const head = await ws.fetch("change", remote(), "changes/early");
		const base = await ws.mergeBase(await ws.head(), head);
		expect(base).toBe(git("merge-base", "main", "changes/early"));
		expect(await ws.changedPaths(base, head)).toEqual(["early.txt"]);
		expect(await ws.tryMerge(await ws.head(), head)).toEqual({ clean: true });
	});

	it("deepens to read history back to an old commit", async () => {
		const baseline = git("rev-list", "--max-parents=0", "main");
		const records = await readMainMerges(remote(), baseline, "main");
		expect(records).toHaveLength(Number(git("rev-list", "--count", `${baseline}..main`)));
	});
});
