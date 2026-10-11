import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentClone } from "./helpers/agents";
import { FakeStorage } from "./fakes/env";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { localContainer } from "./helpers/local-container";

vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => ({
		url: `https://git.test/${name}.git`,
		token: `${scope}-token`,
	})),
}));

const { Gate } = await import("../src/gate");
const { githubGate } = await import("../src/gate-github");
const exec = promisify(execFile);

// The repo's own Gate brings GitHub's branch into the project as github/main,
// for githive-github to merge. Whichever way GitHub merged GitHive's pull
// request, what comes in merges onto GitHive's main with only what GitHub added:
// a merge commit already has GitHive's commit as a parent, and a squash or a
// rebase, which gave GitHive's commits new ids, is joined to the commit of
// GitHive's whose files it has.

let server: GitServer;
let github: FakeGitHub;
let work: string;
let gate: InstanceType<typeof Gate>;
let clone: Awaited<ReturnType<typeof agentClone>>;

const main = () => server.git("rev-parse", "main").trim();
const parents = (commit: string) => server.git("log", "-1", "--format=%P", commit).trim().split(" ");
const tree = (commit: string) => server.git("rev-parse", `${commit}^{tree}`).trim();

/** A landing on GitHive's main: `files` committed there. */
async function landOnMain(files: Record<string, string>, message = "a landing") {
	await clone.run("pull", "-q", "origin", "main");
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "-q", "-m", message);
	await clone.run("push", "-q", "origin", "main");
	return main();
}

/** GitHive's main pushed to githive/main on GitHub, as a landing in pr mode does. */
function pushPullBranch() {
	github.git("fetch", "-q", server.git("rev-parse", "--absolute-git-dir").trim(), "main:refs/heads/githive/main");
	github.pulls.push({
		number: 1,
		url: "u",
		title: "GitHive: changes",
		body: "",
		head: "githive/main",
		base: "main",
		open: true,
	});
	return github.head("githive/main");
}

const importGitHub = () =>
	gate.importGitHub({
		repo: "p",
		branch: "main",
		base: { remote: server.url, token: "unused" },
		baseHead: main(),
		from: { remote: github.link.remote.url, token: "unused", user: "x-access-token" },
		githubBranch: "main",
		as: "github/main",
	});

/** Whether merging `head` onto main is clean, and the files it would change there. */
async function mergeOntoMain(head: string) {
	const dir = join(work, `merge-${Math.random().toString(36).slice(2, 6)}`);
	await exec("git", ["clone", "-q", server.url, dir]);
	const git = (...args: string[]) =>
		exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
	await git("fetch", "-q", "origin", "github/main");
	const merged = await git("merge", "-q", "--no-ff", "-m", "merge", head).then(
		() => true,
		() => false,
	);
	const files = merged ? (await git("diff", "--name-only", "HEAD^1", "HEAD")).stdout.trim() : "";
	return { clean: merged, files: files ? files.split("\n") : [] };
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-github-import-"));
	clone = await agentClone(server.url, work, "lander");
	// GitHive's main with a file of its own, mirrored to GitHub before pr mode began.
	await landOnMain({ "src/app.js": "one\n" }, "the start");
	github = await fakeGitHub(server);
	gate = gateNamed(githubGate("p"));
});

/** The Gate called `name`: Gates are told apart by the name their object was got by. */
function gateNamed(name: string) {
	return new Gate(
		{
			storage: new FakeStorage(),
			container: localContainer(join(work, `checkout-${name.replaceAll(":", "-")}`)),
			id: { equals: (other: string) => other === name },
		} as never,
		{ GATE: { idFromName: (named: string) => named, getByName: () => ({ snapshot: async () => null }) } } as never,
	);
}
afterEach(async () => {
	github.close();
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("bringing GitHub's branch into the project", { timeout: 60_000 }, () => {
	it("runs in the repo's GitHub Gate, never in the one that lands its batches, so GitHub holds up no landing", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		github.push({ "docs/notes.md": "from GitHub\n" });
		gate = gateNamed("repo:p");
		await expect(importGitHub()).rejects.toThrow("only the repo's GitHub Gate imports from GitHub");
		expect(server.git("branch", "--list", "github/main").trim()).toBe("");
		// The toolkit asks the GitHub Gate.
		const asked: string[] = [];
		const env = {
			GATE: {
				getByName: (name: string) => {
					asked.push(name);
					return { importGitHub: async () => ({ known: "k".repeat(40) }) };
				},
			},
			TREE_LANDING: "off",
		} as unknown as Env;
		const { toolContextFor } = await import("../src/toolkit/env");
		const from = { url: github.link.remote.url, token: "t", user: "x-access-token" };
		const batchGit = toolContextFor(env, "service:githive-github").batchGit!("p");
		await batchGit.importBranch!({ base: main(), branch: "main", from, githubBranch: "main", as: "github/main" });
		expect(asked).toEqual(["repo:p:github"]);
	});

	it("leaves it alone when main already has it", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		expect(await importGitHub()).toEqual({ known: github.head() });
		expect(server.git("branch", "--list", "github/main").trim()).toBe("");
	});

	it("takes a merge commit as it is: GitHive's commit is one of its parents", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		const pulled = pushPullBranch();
		const merged = github.mergePull("merge");
		// GitHive lands more meanwhile, on the same lines.
		await landOnMain({ "src/app.js": "three\n" });
		expect(await importGitHub()).toEqual({ commit: merged, head: merged, base: pulled });
		expect(server.git("rev-parse", "github/main").trim()).toBe(merged);
		expect(await mergeOntoMain(merged)).toEqual({ clean: true, files: [] });
	});

	it.each(["squash", "rebase"] as const)(
		"joins a %s merge to the GitHive commit whose files it has, so it merges with nothing to change",
		async (how) => {
			await landOnMain({ "src/app.js": "two\n" });
			const pulled = pushPullBranch();
			const merged = github.mergePull(how);
			expect(parents(pulled)).not.toContain(merged);
			// GitHive lands more meanwhile, on the very lines the pull request changed.
			await landOnMain({ "src/app.js": "three\n" });
			const imported = await importGitHub();
			expect(imported).toMatchObject({ commit: merged, base: pulled });
			const { head } = imported as { head: string };
			expect(parents(head)).toEqual([merged, pulled]);
			expect(tree(head)).toBe(tree(merged));
			// git's own merge base would be GitHub's branch before the pull request, setting "two" against "three".
			expect(await mergeOntoMain(merged)).toMatchObject({ clean: false });
			expect(await mergeOntoMain(head)).toEqual({ clean: true, files: [] });
			// Imported again, it's the same commit: each step can be tried again.
			expect(await importGitHub()).toEqual(imported);
		},
	);

	it("brings commits pushed straight to GitHub as they are, with what they changed", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		const imported = await importGitHub();
		expect(imported).toMatchObject({ commit: pushed, head: pushed });
		expect(await mergeOntoMain(pushed)).toEqual({ clean: true, files: ["docs/notes.md"] });
	});

	it("brings a revert on GitHub of what a squash took back as a revert, not as an older squash taken", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		pushPullBranch();
		const first = github.mergePull("squash");
		// GitHive brings the first squash back, as githive-github's merge does.
		const { head: joined } = (await importGitHub()) as { head: string };
		await clone.run("pull", "-q", "origin", "main");
		await clone.run("fetch", "-q", "origin", "github/main");
		await clone.run("merge", "-q", "--no-ff", "-m", "Bring in GitHub's changes", joined);
		await clone.run("push", "-q", "origin", "main");
		await landOnMain({ "src/app.js": "three\n" });
		const pulled = pushPullBranch();
		const second = github.mergePull("squash");
		// Someone on GitHub reverts the second squash: GitHub's files are as the first squash left them.
		const reverted = github
			.git("commit-tree", "-p", second, "-m", "Revert the second squash", `${first}^{tree}`)
			.trim();
		github.git("update-ref", "refs/heads/main", reverted);
		await landOnMain({ "src/notes.js": "unrelated\n" });
		const imported = (await importGitHub()) as { head: string; base: string };
		// GitHub took GitHive's newer work, then went back on it: what comes back undoes it.
		expect(imported).toMatchObject({ commit: reverted, base: pulled });
		expect(await mergeOntoMain(imported.head)).toEqual({ clean: true, files: ["src/app.js"] });
	});

	it("brings what was pushed after a squash, joined to what the squash took", async () => {
		await landOnMain({ "src/app.js": "two\n" });
		const pulled = pushPullBranch();
		github.mergePull("squash");
		const pushed = github.push({ "docs/notes.md": "after the squash\n" });
		await landOnMain({ "src/app.js": "three\n" });
		const imported = (await importGitHub()) as { head: string; base: string };
		expect(imported.base).toBe(pulled);
		expect(parents(imported.head)).toEqual([pushed, pulled]);
		expect(await mergeOntoMain(imported.head)).toEqual({ clean: true, files: ["docs/notes.md"] });
	});
});

describe("the import record", { timeout: 60_000 }, () => {
	it("notes each commit brought in once, stamped, and counts only what GitHive stamped", async () => {
		const { GitCasLog } = await import("../src/record-log");
		const { importsRef, recordImport, verifiedImports } = await import("../src/toolkit/github-imports");
		const { generateStampKey, makeStamper } = await import("../src/toolkit/stamp");
		const { privateKey, publicKey } = await generateStampKey();
		const stamper = await makeStamper(privateKey, "service:githive-github");
		const log = new GitCasLog<import("../src/toolkit/github-imports").GitHubImports>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			importsRef("p"),
		);
		const entry = { github: "acme/shop", branch: "main", commit: "c".repeat(40), head: "h".repeat(40), base: main() };
		const first = await recordImport(log, entry, stamper);
		expect(first).toMatchObject({ ...entry, by: "service:githive-github", stamp: expect.any(String) });
		// Recorded again (a step tried again), it's the same entry.
		expect(await recordImport(log, entry, stamper)).toEqual(first);
		const { imports } = (await log.read())!.commit.state;
		expect(imports).toEqual([first]);
		// One written by hand, unstamped, doesn't count.
		const forged = { ...entry, head: "f".repeat(40), at: first.at };
		expect(await verifiedImports([...imports, forged], publicKey)).toEqual([first]);
		expect(await verifiedImports([...imports, forged], undefined)).toEqual([first, forged]);
	});
});
