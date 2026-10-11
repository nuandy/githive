import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { inert, pullStory } from "../src/toolkit/github-pr";
import type { LandedChange } from "../src/toolkit/history";
import { repoSnapshot } from "../src/toolkit/mcp";
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
	gaveUp: async () => undefined,
	state: async () => ({ pull, job: null }),
};
const { ctx, call, keys, register, approve } = toolCalls(() => server, {
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
		expect(github.pulls[0]!.body).toContain("**`Add c-1`** (`c-1`, by `a`)");
		expect(github.pulls[0]!.body).toContain("reviewed by `reviewer` (`review`): `ok`");
		expect(pull).toMatchObject({ number: 1, url: "https://github.com/acme/shop/pull/1" });
		// The dashboard shows it by the repo's name.
		expect((await repoSnapshot(ctx(), "p")).github).toEqual({
			repo: "acme/shop",
			sync: "pr",
			trust: true,
			inbound: true,
			pull: { number: 1, url: "https://github.com/acme/shop/pull/1" },
		});
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

	it("says what it can't tell when GitHub's head is a commit GitHive hasn't brought back yet", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		// Someone pushes to GitHub's main; GitHive brings it back in a job of its own, after this asks.
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		const opened = await call("github_pr", {});
		expect(opened).toMatchObject({ opened: true, title: "GitHive: changes since main last took GitHive's work" });
		expect(opened).not.toHaveProperty("changes");
		expect(noticed).toContainEqual({ github: "acme/shop", branch: "main", commit: pushed });
		expect(github.pulls[0]!.body).not.toContain("Add c-1");
	});

	it("opens a new pull request once the last was closed on GitHub without merging", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		expect(await call("github_pr", {})).toMatchObject({ number: 1, opened: true });
		// Someone closes it on GitHub, unmerged.
		github.pulls[0]!.open = false;
		await land("c-2", { "src/b.js": "b\n" });
		expect(await call("github_pr", {})).toMatchObject({ number: 2, opened: true, title: "GitHive: 2 changes" });
		expect(github.pulls.map((pr) => pr.open)).toEqual([false, true]);
	});

	it("points the pull request at GitHub's default branch when that changes", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		expect(await call("github_pr", {})).toMatchObject({ number: 1, opened: true });
		github.setDefault("trunk");
		const asked = await call("github_pr", {});
		expect(asked).toMatchObject({ number: 1, open: true });
		expect(asked.note).toContain("it goes into main, but acme/shop's default branch is trunk now");
		// GitHub's new default branch is noticed too, to bring back what it holds.
		expect(noticed.at(-1)).toMatchObject({ branch: "trunk" });
		expect(await call("github_pr", { refresh: true })).toMatchObject({ number: 1, refreshed: true });
		expect(github.pulls[0]).toMatchObject({ base: "trunk", open: true });
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

	it("answers the merging agent soon when GitHub's API takes the read and never answers", async () => {
		github.stallCalls(1);
		const started = Date.now();
		expect(await land("c-1", { "src/a.js": "a\n" })).toMatchObject({ ok: true });
		// The read is given up after 5 seconds, and nothing is noticed: the next landing looks again.
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(github.calls).toEqual(["GET default"]);
		expect(noticed).toEqual([]);
		expect(github.head("githive/main")).toBe(server.git("rev-parse", "main").trim());
	});
});

describe("a GitHive without the GitHubSync object", { timeout: 60_000 }, () => {
	const unsynced = toolCalls(() => server, { github: async (repo) => (repo === "acme/shop" ? github.link : null) });

	it("still pushes githive/main and opens the pull request in pr mode, and reads nothing it can't tell anyone", async () => {
		Object.assign(unsynced.keys, keys);
		await unsynced.call("settings", { github: "acme/shop" });
		await unsynced.call("claim", { change: "c-1", agent: "a", paths: ["src/a.js"], intent: "Add c-1" }, "a");
		await approve(await pushChange(server.url, work, "a", "c-1", { "src/a.js": "a\n" }));
		expect(await unsynced.call("merge", { change: "c-1", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(github.head("githive/main")).toBe(server.git("rev-parse", "main").trim());
		expect(github.calls).toEqual([]);
		const opened = await unsynced.call("github_pr", {});
		expect(opened).toMatchObject({ opened: true, title: "GitHive: 1 change" });
		expect(opened).not.toHaveProperty("fromGitHub");
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

describe("the pull request's body", () => {
	/** The body with its code spans taken out: what GitHub reads for closing keywords, mentions and references. */
	const outsideCode = (body: string) => body.replace(/(`+)[^`][\s\S]*?\1/g, "");
	const change = (intent: string, evidence: string, reviewer = "reviewer"): LandedChange => ({
		commit: "m".repeat(40),
		change: "c-1",
		agent: "agent-a",
		head: "h".repeat(40),
		title: intent,
		intent,
		files: ["src/a.js"],
		reviews: [{ reviewer, role: "review", verdict: "approve", evidence }],
	});

	const since = "5".repeat(40);
	const story = (listed: LandedChange[], count = listed.length) => pullStory({ since, count, listed }, "main");

	it("gives GitHub nothing to act on in what agents wrote: no closing keyword, mention, reference or markup", () => {
		const { body } = story([
			change("Closes #12, and Fixes acme/shop#3", "@org/team: looks good, see #4 <img src=x>"),
			change("Tidy `src/a.js` [link](https://evil.example)", "fine", "person:ana@example.com"),
		]);
		expect(body).toContain("**`Closes #12, and Fixes acme/shop#3`**");
		expect(body).toContain("`@org/team: looks good, see #4 <img src=x>`");
		expect(body).toContain("**``Tidy `src/a.js` [link](https://evil.example)``**");
		expect(body).toContain("reviewed by `person:ana@example.com`");
		const plain = outsideCode(body);
		expect(plain).not.toMatch(/#\d|@\w|<img|\]\(/);
		expect(plain).not.toMatch(/closes|fixes/i);
	});

	it("fences text that starts or ends with a backtick, and caps a long intent", () => {
		expect(inert("`rm -rf`")).toBe("`` `rm -rf` ``");
		expect(inert("")).toBe("(none)");
		expect(inert("a\n\nb")).toBe("`a b`");
		const { body } = story([change("x".repeat(500), "ok")]);
		expect(body).toContain(`\`${"x".repeat(199)}…\``);
	});

	it("lists at most 50 changes, newest first, and counts the rest since the commit GitHub last took", () => {
		const landed = Array.from({ length: 70 }, (_, k) => change(`Change ${70 - k}`, "ok"));
		const told = story(landed.slice(0, 50), 70);
		expect(told).toMatchObject({ title: "GitHive: 70 changes", changes: 70 });
		expect(told.body).toContain("since `main` last took GitHive's work (`55555555`), newest first");
		expect(told.body.indexOf("`Change 70`")).toBeLessThan(told.body.indexOf("`Change 21`"));
		expect(told.body).not.toContain("`Change 20`");
		expect(told.body).toContain("- …and 20 more since `55555555`");
	});

	it("lists nothing when GitHub's head is no commit of GitHive's, rather than everything since GitHive started", () => {
		const told = pullStory({ since: null, count: 70, listed: [change("Change 1", "ok")] }, "main");
		expect(told).toMatchObject({ title: "GitHive: changes since main last took GitHive's work", changes: null });
		expect(told.body).toContain("What landed on GitHive since `main` last took GitHive's work.");
		expect(told.body).not.toContain("Change 1");
	});
});
