import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/git";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Workspaces live in memory (src/memory-fs.ts), and isomorphic-git checks files out into it. A repo with an
// executable file in it failed every clone once: checkout sets the file's mode on its stats, which couldn't be set.

let server: GitServer;
let work: string;

beforeEach(async () => {
	server = await startGitServer({ branch: "master" });
	work = mkdtempSync(join(tmpdir(), "githive-memory-fs-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/** Commits `bin/run` as an executable file, and `README.md` as a plain one, onto the server's master. */
async function pushExecutable() {
	const clone = await agentClone(server.url, work, "maker");
	clone.write("bin/run", "#!/bin/sh\necho run\n");
	chmodSync(join(work, "maker", "bin/run"), 0o755);
	clone.write("README.md", "a readme\n");
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", "An executable file");
	await clone.run("push", "--quiet", "origin", "master");
}

describe("a workspace in memory", () => {
	it("clones a branch with an executable file in it, and keeps the file executable", async () => {
		await pushExecutable();
		const workspace = await Workspace.clone({ url: server.url, token: "test" }, "master");
		const { fs, dir } = workspace.held;
		expect((await fs.promises.lstat(`${dir}/bin/run`)).mode).toBe(0o100755);
		expect((await fs.promises.lstat(`${dir}/README.md`)).mode).toBe(0o100644);
	});
});
