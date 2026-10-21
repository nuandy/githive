import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommit } from "../demo/demo-repo";
import { TEMPLATE_FILES } from "../demo/template-files";
import { Workspace } from "../../src/git";
import { writeFirstCommit } from "../../src/repo-init";
import { startGitServer, type GitServer } from "../../test/helpers/git-server";

// A demo run starts over by putting Honeycomb's starting files back on top of what the last run built, in one commit
// its reset change pushes for the hive to review.

let server: GitServer;
// An empty repo of its own, as the demo repo is before its first commit.
const remote = () => ({ url: server.repo("honeycomb"), token: "t" });
const git = (...args: string[]) => server.gitIn("honeycomb", ...args);
const AUTHOR = { name: "githive-demo", email: "githive-demo@agents.githive.app" };

beforeEach(async () => {
	server = await startGitServer();
	await writeFirstCommit(remote(), TEMPLATE_FILES, AUTHOR);
});
afterEach(() => server.close());

/** What a run builds: a new module, a test, and a change to a starting file. */
async function buildSomething() {
	const workspace = await Workspace.clone(remote(), "main");
	await workspace.write({
		"src/board.js": "export const board = 1;\n",
		"test/board.test.js": "// tests\n",
		"README.md": "changed\n",
	});
	await workspace.commit("Build the board", AUTHOR);
	await workspace.push("main");
}

describe("a demo run's reset", () => {
	it("has nothing to do while main holds just the starting files", async () => {
		expect(await resetCommit(remote(), 2)).toBeUndefined();
	});

	it("removes what the last run built and puts the starting files back, on top of main", async () => {
		await buildSomething();
		const main = git("rev-parse", "main").trim();
		const reset = await resetCommit(remote(), 2);
		expect(reset?.paths).toEqual(expect.arrayContaining(["README.md", "src/", "test/"]));
		await reset!.workspace.pushAs("refs/heads/main", "refs/heads/changes/reset-2", remote());
		expect(git("rev-parse", "changes/reset-2^").trim()).toBe(main);
		const files = git("ls-tree", "-r", "--name-only", "changes/reset-2").trim().split("\n");
		expect(files.sort()).toEqual(Object.keys(TEMPLATE_FILES).sort());
		expect(git("show", "changes/reset-2:README.md")).toBe(TEMPLATE_FILES["README.md"]);
	});
});
