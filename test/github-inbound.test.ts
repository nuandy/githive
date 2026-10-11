import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubSync } from "../src/github-sync";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { type GitHubImports, importsRef } from "../src/toolkit/github-imports";
import { GITHUB_AGENT, GITHUB_IDENTITY, type GitHubSyncHandle } from "../src/toolkit/github-settings";
import type { ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { FakeStorage } from "./fakes/env";
import { pushChange } from "./helpers/agents";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github";
import { linkBeforeModes } from "./helpers/github-link";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// GitHub's changes come back through GitHive's own path: whatever GitHub's
// branch gains (the pull request's merge, by merge commit, squash or rebase, or
// commits people pushed there) is noticed after a landing, imported by the
// repo's Gate as github/main, claimed by githive-github as a source merge, and
// landed through the batch without votes while the repo trusts GitHub. The
// audit accepts it against the import record. A conflict sends it to a person.

let server: GitServer;
let github: FakeGitHub;
let work: string;
let storage: FakeStorage;
let sync: GitHubSync;
let privateKey: string;

const handle = (): GitHubSyncHandle => ({
	notice: (seen, again) => sync.notice({ ...seen, repo: "p" }, again),
	notePull: (pull) => sync.notePull(pull),
	state: () => sync.state(),
});
const extra: Partial<ToolContext> = {
	github: async (repo) => (repo === "acme/shop" ? github.link : null),
	githubSync: () => handle(),
	stamper: async (agent) => makeStamper(privateKey, agent ? `service:test/${agent}` : "service:test"),
};
const { ctx, call, register, approve } = toolCalls(() => server, extra);

/** githive-github's job, as the repo's GitHubSync runs it: a hosted context stamped as it. */
class TestSync extends GitHubSync {
	protected override toolContext(): ToolContext {
		const { githubSync: _, ...rest } = ctx();
		return { ...rest, hosted: true, stamper: async () => makeStamper(privateKey, GITHUB_IDENTITY) };
	}
}

/** Runs the job's steps, alarm after alarm, until none is set. */
async function settle() {
	for (let alarms = 0; storage.alarm !== null && alarms < 50; alarms++) {
		storage.alarm = null;
		await sync.alarm();
	}
	return (await sync.state()).job;
}

/** A change claimed, pushed, approved and merged by agent a: a landing, which pushes githive/main. */
async function land(change: string, files: Record<string, string>) {
	await call("claim", { change, agent: "a", paths: Object.keys(files), intent: `Add ${change}` }, "a");
	await approve(await pushChange(server.url, work, "a", change, files));
	expect(await call("merge", { change, agent: "a" }, "a")).toMatchObject({ ok: true });
	return settle();
}

const main = () => server.git("rev-parse", "main").trim();
const lastMerge = () => {
	const [subject, parents, ...rest] = server.git("log", "-1", "--format=%s%n%P%n%B", "main").split("\n");
	return { subject, parents: parents!.split(" "), message: rest.join("\n") };
};
const imports = async () =>
	(await new GitCasLog<GitHubImports>(async () => ({ url: server.url, token: "unused" }), "p", importsRef("p")).read())
		?.commit.state.imports ?? [];
const claimsNow = async () =>
	(
		await new GitCasLog<Registry>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			"refs/notes/githive-claims/p",
		).read()
	)?.commit.state.claims ?? [];

beforeEach(async () => {
	server = await startGitServer();
	github = await fakeGitHub(server);
	work = mkdtempSync(join(tmpdir(), "githive-inbound-"));
	({ privateKey } = await generateStampKey());
	storage = new FakeStorage();
	sync = new TestSync({ storage } as never, {} as never);
	// Reviews are required, so a change landing without votes is the trust rule at work.
	await call("settings", { required: 1, vetoes: [] });
	await call("settings", { github: "acme/shop" });
	await register("a", "reviewer");
});
afterEach(async () => {
	github.close();
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("GitHub's changes coming back", { timeout: 120_000 }, () => {
	it("finds nothing to bring back while GitHub's branch is behind main", async () => {
		const job = await land("c-1", { "src/a.js": "a\n" });
		expect(job).toMatchObject({ step: "done", reason: "main has it already", commit: github.head() });
		// Noticed again, the same commit starts nothing.
		await land("c-2", { "src/b.js": "b\n" });
		expect(await imports()).toEqual([]);
	});

	it.each(["merge", "squash", "rebase"] as const)(
		"brings a pull request merged by %s back as one trusted change, without votes, and the audit agrees",
		async (how) => {
			await land("c-1", { "src/a.js": "a\n" });
			expect(await call("github_pr", {})).toMatchObject({ opened: true, title: "GitHive: 1 change" });
			const merged = github.mergePull(how);
			// The next landing notices GitHub's branch moved, and the job brings it back.
			const job = await land("c-2", { "src/b.js": "b\n" });
			expect(job).toMatchObject({ step: "done", commit: merged, change: `github-${merged.slice(0, 12)}` });
			const [imported] = await imports();
			expect(imported).toMatchObject({ github: "acme/shop", branch: "main", commit: merged, by: GITHUB_IDENTITY });
			expect(server.git("rev-parse", "github/main").trim()).toBe(imported!.head);
			const landed = lastMerge();
			expect(landed.subject).toBe(`Bring in GitHub's changes (acme/shop main at ${merged.slice(0, 12)})`);
			expect(landed.parents[1]).toBe(imported!.head);
			expect(landed.message).toContain(`GitHive-Agent: ${GITHUB_AGENT}`);
			// GitHub's commit is on main now, and what it took brought nothing to change: same files as before.
			server.git("merge-base", "--is-ancestor", merged, "main");
			expect(server.git("diff", "--name-only", `${landed.parents[0]}`, "main").trim()).toBe("");
			expect(await call("audit", {})).toMatchObject({ merges: 3, open: 0 });
			// The next pull request shows only what's new since.
			await land("c-3", { "src/c.js": "c\n" });
			expect(await call("github_pr", {})).toMatchObject({ opened: true, title: "GitHive: 2 changes" });
			expect(github.pulls.at(-1)!.body).not.toContain("Add c-1");
			expect(github.pulls.at(-1)!.body).not.toContain("Bring in GitHub's changes");
		},
	);

	it("brings commits pushed straight to GitHub back the same way, with what they changed", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		const job = await land("c-2", { "src/b.js": "b\n" });
		expect(job).toMatchObject({ step: "done", commit: pushed });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
		expect(lastMerge().parents[1]).toBe(pushed);
		// It held what it changed while it landed, and let go after.
		expect((await claimsNow()).filter((claim) => claim.agent === GITHUB_AGENT)).toEqual([]);
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("sends a conflicting change to a person, lands nothing, and lets it go once GitHub's branch is fixed", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		// GitHub and GitHive change the same line differently.
		const theirs = github.push({ "src/a.js": "from GitHub\n" });
		const job = await land("c-2", { "src/a.js": "from GitHive\n" });
		expect(job).toMatchObject({ step: "needs a person", commit: theirs, reason: expect.stringContaining("conflicts") });
		expect(server.git("show", "main:src/a.js")).toBe("from GitHive\n");
		const change = `github-${theirs.slice(0, 12)}`;
		expect(await call("status", { change })).toMatchObject({
			claim: { agent: GITHUB_AGENT, source: "github/main" },
			trusted: expect.stringContaining("without review"),
		});
		const snapshot = (await import("../src/toolkit/mcp")).repoSnapshot;
		const shown = (await snapshot(ctx(), "p")).claims.find((claim) => claim.change === change);
		expect(shown?.attention?.reason).toMatch(/^GitHub's changes need a person: .*conflicts/);
		// Someone fixes it on GitHub, merging githive/main there; the next landing brings the fix back.
		github.git("fetch", "-q", server.git("rev-parse", "--absolute-git-dir").trim(), "main:refs/heads/githive/main");
		const fixed = github.mergePull("merge", "theirs");
		expect(fixed).not.toBe(theirs);
		const after = await land("c-3", { "src/c.js": "c\n" });
		expect(after).toMatchObject({ step: "done", commit: fixed });
		expect((await claimsNow()).filter((claim) => claim.agent === GITHUB_AGENT)).toEqual([]);
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("needs review like any change when the repo doesn't trust GitHub's changes", async () => {
		await call("settings", { github_trust: false });
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		const job = await land("c-2", { "src/b.js": "b\n" });
		expect(job).toMatchObject({ step: "waiting", reason: expect.stringContaining("waits for review") });
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("docs/notes.md");
		const change = `github-${pushed.slice(0, 12)}`;
		expect(await call("reviews", { agent: "reviewer" }, "reviewer")).toMatchObject({
			reviews: [expect.objectContaining({ change })],
		});
		// Approved, it lands with the next batch, and the audit counts its approval.
		const head = server.git("rev-parse", "github/main").trim();
		await approve(head);
		await land("c-3", { "src/c.js": "c\n" });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("never fails a landing when GitHub or the import does", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		github.push({ "docs/notes.md": "from GitHub\n" });
		// GitHub's git goes away: the landing lands, and the job tries again, then waits to be noticed again.
		const away = github.link.remote.url;
		github.link.remote.url = `${away}-gone`;
		const job = await land("c-2", { "src/b.js": "b\n" });
		expect(job).toMatchObject({ step: "failed", reason: expect.stringContaining("fetching GitHub's main failed") });
		github.link.remote.url = away;
		// Not at every landing: a commit that can't come in would start a container each time. Asked, it goes on.
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ step: "failed" });
		await sync.notice({ repo: "p", github: "acme/shop", branch: "main", commit: github.head() }, true);
		expect(await settle()).toMatchObject({ step: "done" });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
	});
});

describe("a link made before modes", { timeout: 120_000 }, () => {
	beforeEach(async () => {
		await linkBeforeModes(server, "p", "acme/shop");
	});

	it("never starts the GitHub job: it mirrors, as it always did", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		expect(github.head()).toBe(main());
		// Someone pushes to GitHub: the next push is refused, and nothing comes back.
		github.push({ "docs/notes.md": "from GitHub\n" });
		expect(await land("c-2", { "src/b.js": "b\n" })).toBeNull();
		expect(await sync.state()).toEqual({ job: null, pull: null });
		expect(github.calls).toEqual([]);
		expect(server.git("ls-tree", "-r", "--name-only", "main")).not.toContain("docs/notes.md");
		expect(await imports()).toEqual([]);
		// Asking about a pull request starts nothing either.
		await call("github_pr", {}).catch(() => undefined);
		expect((await sync.state()).job).toBeNull();
	});

	it("brings GitHub's changes back once github_sync is set, to mirror too", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await call("settings", { github_sync: "mirror" });
		expect(await land("c-2", { "src/b.js": "b\n" })).toMatchObject({ step: "done", commit: pushed });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
		// A mirror has no pull request to look for once it landed.
		expect(github.calls.filter((call) => call.startsWith("GET pulls"))).toEqual([]);
		// Trusted: it landed without the review the repo asks for, and the audit agrees.
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});
});

describe("noticing GitHub's branch", () => {
	it("starts a job only when there may be something to bring back, and never two at once", async () => {
		const { noticed, newJob } = await import("../src/toolkit/github-inbound");
		const seen = { github: "acme/shop", branch: "main", commit: "c1" };
		const now = Date.parse("2026-10-11T12:00:00Z");
		const job = (step: string, commit = "c1", minutesAgo = 0) => ({
			...newJob("p", { ...seen, commit }, now - minutesAgo * 60_000),
			step: step as never,
		});
		expect(noticed(null, null, seen, "p", false, now)).toMatchObject({ step: "import", commit: "c1" });
		// Known to be on main.
		expect(noticed(null, "c1", seen, "p", false, now)).toBeNull();
		// One runs: it fetches GitHub's newest anyway.
		expect(noticed(job("merge", "c0"), null, seen, "p", false, now)).toBeNull();
		// Unless it lost its alarm long ago.
		expect(noticed(job("merge", "c0", 61), null, seen, "p", false, now)).toMatchObject({ commit: "c1" });
		// Brought back, or sent to a person: not again for the same commit, unless asked.
		expect(noticed(job("done"), null, seen, "p", false, now)).toBeNull();
		expect(noticed(job("needs a person"), null, seen, "p", false, now)).toBeNull();
		expect(noticed(job("needs a person"), null, seen, "p", true, now)).toMatchObject({ step: "import" });
		// A newer commit starts again.
		expect(noticed(job("needs a person", "c0"), null, seen, "p", false, now)).toMatchObject({ commit: "c1" });
		// A job that waited goes on from where it waited, its import done.
		const waited = { ...job("waiting"), resume: "claim" as const, reason: "paths held", head: "h1" };
		expect(noticed(waited, null, seen, "p", false, now)).toMatchObject({ step: "claim", head: "h1" });
		expect(noticed(waited, null, seen, "p", false, now)).not.toHaveProperty("reason");
		// A job that failed starts again only after a while, or when asked.
		expect(noticed(job("failed", "c1", 5), null, seen, "p", false, now)).toBeNull();
		expect(noticed(job("failed", "c1", 5), null, seen, "p", true, now)).toMatchObject({ step: "import" });
		expect(noticed(job("failed", "c1", 61), null, seen, "p", false, now)).toMatchObject({ step: "import" });
	});
});
