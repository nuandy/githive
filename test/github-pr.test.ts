import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import type { GitHubSeen, GitHubSyncHandle, KnownPull } from "../src/toolkit/github-settings";
import { pushChange } from "./helpers/agents";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// GitHive's work reaching GitHub through one standing pull request (pr mode):
// every landing pushes main to githive/main, as a fast-forward, and the pull
// request from it updates itself. github_pr opens it, finds it, and rewrites its
// description. Nothing GitHub does, or fails to do, holds up a landing.

let server: GitServer;
let github: FakeGitHub;
let work: string;
let noticed: GitHubSeen[];
let pull: KnownPull | null;

const handle: GitHubSyncHandle = {
	notice: async (seen) => (noticed.push(seen), { pull, job: null }),
	notePull: async (known) => void (pull = known),
	state: async () => ({ pull, job: null }),
};
const { call, register, approve } = toolCalls(() => server, {
	github: async (repo) => (repo === "acme/shop" ? github.link : null),
	githubSync: () => handle,
});
const tryCall = async (name: string, args: Record<string, unknown>) =>
	call(name, args).catch((err) => ({ error: statusOf(err).message }));

/** A change claimed, pushed, approved and merged. Returns the merge's outcome. */
async function land(change: string, files: Record<string, string>) {
	await call("claim", { change, agent: "a", paths: Object.keys(files), intent: `Add ${change}` }, "a");
	await approve(await pushChange(server.url, work, "a", change, files));
	return call("merge", { change, agent: "a" }, "a");
}

beforeEach(async () => {
	server = await startGitServer();
	github = await fakeGitHub(server);
	work = mkdtempSync(join(tmpdir(), "githive-pr-"));
	noticed = [];
	pull = null;
	await call("settings", { required: 1, vetoes: [] });
	await register("a", "reviewer");
});
afterEach(async () => {
	github.close();
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a repo connected to GitHub in pr mode", { timeout: 60_000 }, () => {
	beforeEach(async () => {
		await call("settings", { github: "acme/shop" });
	});

	it("pushes main to githive/main after a landing, leaves GitHub's main alone, and looks where it is", async () => {
		const githubMain = github.head();
		expect(await land("c-1", { "src/a.js": "a\n" })).toMatchObject({ ok: true });
		const main = server.git("rev-parse", "main").trim();
		expect(github.head("githive/main")).toBe(main);
		expect(github.head()).toBe(githubMain);
		// One read of GitHub's branch, told to the repo's GitHubSync to bring back if main lacks it.
		expect(github.calls).toEqual(["GET default"]);
		expect(noticed).toEqual([{ github: "acme/shop", branch: "main", commit: githubMain }]);
	});

	it("opens one pull request, finds it after that, and rewrites it with refresh", async () => {
		expect(await tryCall("github_pr", {})).toEqual({
			error: "nothing has landed on GitHive since acme/shop's main took its work: no pull request",
		});
		await land("c-1", { "src/a.js": "a\n" });
		const opened = await call("github_pr", {});
		expect(opened).toMatchObject({
			pr: "https://github.com/acme/shop/pull/1",
			number: 1,
			title: "GitHive: 1 change",
			opened: true,
			changes: 1,
		});
		expect(github.pulls).toHaveLength(1);
		expect(github.pulls[0]).toMatchObject({ head: "githive/main", base: "main", open: true });
		// The body tells each change's story: its intent, its agent, and its reviewer's evidence.
		expect(github.pulls[0]!.body).toContain("**Add c-1** (`c-1`, by a)");
		expect(github.pulls[0]!.body).toContain("reviewed by reviewer (review): ok");
		expect(pull).toMatchObject({ number: 1, url: "https://github.com/acme/shop/pull/1" });
		// Asked again, it's found, not opened twice.
		expect(await call("github_pr", {})).toMatchObject({ number: 1, open: true });
		expect(github.pulls).toHaveLength(1);
		// More lands: the pull request takes it without a call (githive/main moved), and refresh rewrites the story.
		await land("c-2", { "src/b.js": "b\n" });
		expect(github.head("githive/main")).toBe(server.git("rev-parse", "main").trim());
		expect(await call("github_pr", { refresh: true })).toMatchObject({
			number: 1,
			title: "GitHive: 2 changes",
			refreshed: true,
		});
		expect(github.pulls[0]!.body.indexOf("Add c-2")).toBeLessThan(github.pulls[0]!.body.indexOf("Add c-1"));
		expect(github.pulls).toHaveLength(1);
	});

	it("pushes githive/main itself when nothing has landed since the repo was connected", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		github.git("update-ref", "-d", "refs/heads/githive/main");
		expect(await call("github_pr", {})).toMatchObject({ opened: true });
		expect(github.head("githive/main")).toBe(server.git("rev-parse", "main").trim());
	});

	it("lands whatever GitHub does: githive/main pushed by someone else, or its API down", async () => {
		// Someone pushes to githive/main on GitHub: GitHive's push is refused and logged, never forced.
		await land("c-1", { "src/a.js": "a\n" });
		const theirs = github
			.git("commit-tree", "-m", "theirs", "-p", github.head("githive/main"), `${github.head("githive/main")}^{tree}`)
			.trim();
		github.git("update-ref", "refs/heads/githive/main", theirs);
		expect(await land("c-2", { "src/b.js": "b\n" })).toMatchObject({ ok: true });
		expect(github.head("githive/main")).toBe(theirs);
		// GitHub's API failing doesn't fail the landing either.
		github.failCalls(10);
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ ok: true });
	});
});

describe("a repo connected to GitHub in mirror mode", { timeout: 60_000 }, () => {
	it("pushes main to GitHub's main, and reads GitHub's branch only when the push is refused", async () => {
		await call("settings", { github: "acme/shop", github_sync: "mirror" });
		await land("c-1", { "src/a.js": "a\n" });
		expect(github.head()).toBe(server.git("rev-parse", "main").trim());
		expect(github.calls).toEqual([]);
		// Someone pushes to GitHub's main: the next push is refused, and GitHive looks where it is.
		const direct = github.push({ "notes.md": "from GitHub\n" });
		await land("c-2", { "src/b.js": "b\n" });
		expect(github.head()).toBe(direct);
		expect(github.calls).toEqual(["GET default"]);
		expect(noticed).toEqual([{ github: "acme/shop", branch: "main", commit: direct }]);
		expect(await tryCall("github_pr", {})).toMatchObject({
			error: 'p mirrors main to acme/shop: set github_sync to "pr" for a pull request',
		});
	});
});
