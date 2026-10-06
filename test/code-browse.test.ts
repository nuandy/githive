import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTree, readFile } from "../src/code-browse";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The dashboard's Code tab: a repo's files at a branch or commit, and one file's text.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });

beforeEach(async () => {
	server = await startGitServer({ branch: "master" });
	work = mkdtempSync(join(tmpdir(), "code-browse-"));
	// Built by path: git over HTTP would wait on this process's own server.
	const repos = join(server.git("rev-parse", "--absolute-git-dir").trim(), "..");
	execFileSync("git", ["clone", "--quiet", join(repos, "project.git"), work]);
	mkdirSync(join(work, "lib"));
	writeFileSync(join(work, "lib/app.js"), "module.exports = 1;\n");
	writeFileSync(join(work, "README.md"), "# Hello\n");
	writeFileSync(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
	execFileSync("git", ["-C", work, "add", "-A"]);
	execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "files"]);
	execFileSync("git", ["-C", work, "push", "--quiet", "origin", "master"]);
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("browsing a repo's code", () => {
	it("lists the files at a branch, and reads one", async () => {
		const tree = await listTree(remote(), "master");
		expect(tree).toEqual({ commit: server.git("rev-parse", "master").trim(), files: ["README.md", "lib/app.js", "logo.png"], truncated: false });
		expect(await readFile(remote(), "master", "lib/app.js")).toMatchObject({ path: "lib/app.js", text: "module.exports = 1;\n", size: 20 });
		expect(await readFile(remote(), tree.commit, "logo.png")).toMatchObject({ binary: true });
	});

	it("refuses paths outside the repo, and says what's missing", async () => {
		await expect(readFile(remote(), "master", "../etc/passwd")).rejects.toThrow(/\[400\]/);
		await expect(readFile(remote(), "master", "nope.txt")).rejects.toThrow(/\[404\] no file nope.txt/);
		await expect(listTree(remote(), "main")).rejects.toThrow(/\[404\] no branch main/);
	});
});
