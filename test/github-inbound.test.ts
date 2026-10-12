import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubSync } from "../src/github-sync";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { type GitHubImports, importsRef } from "../src/toolkit/github-imports";
import { GITHUB_AGENT, GITHUB_IDENTITY, type GitHubSyncHandle } from "../src/toolkit/github-settings";
import { memoryLanding } from "../src/toolkit/landing";
import { callTool, repoSnapshot, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import type { Votes } from "../src/toolkit/votes";
import { FakeStorage } from "./fakes/env";
import { agentClone, pushChange } from "./helpers/agents";
import { fakeGitHub, type FakeGitHub } from "./helpers/fake-github";
import { linkBeforeModes } from "./helpers/github-link";
import { memoryBatchGit } from "./helpers/memory-batch-git";
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
	notice: (seen, asked) => sync.notice({ ...seen, repo: "p" }, asked),
	notePull: (pull) => sync.notePull(pull),
	gaveUp: (change, reason) => sync.gaveUp(change, reason),
	state: () => sync.state(),
});
const extra: Partial<ToolContext> = {
	github: async (repo) => (repo === "acme/shop" ? github.link : null),
	githubSync: () => handle(),
	stamper: async (agent) => makeStamper(privateKey, agent ? `service:test/${agent}` : "service:test"),
};
const { ctx, call, keys, register, approve } = toolCalls(() => server, extra);

/** A hosted context stamped as service:githive-github, as the repo's GitHubSync acts. */
function githubAgent(): ToolContext {
	const { githubSync: _, ...rest } = ctx();
	return {
		...rest,
		hosted: true,
		identity: GITHUB_IDENTITY,
		stamper: async () => makeStamper(privateKey, GITHUB_IDENTITY),
	};
}

/** githive-github's job, as the repo's GitHubSync runs it. */
class TestSync extends GitHubSync {
	protected override toolContext(): ToolContext {
		return githubAgent();
	}
}

/** Agent a's change deleting `path` from main, pushed; returns its head. */
async function pushDeletion(change: string, path: string) {
	const clone = await agentClone(server.url, work, `a-${change}`);
	await clone.run("checkout", "-q", "-b", `changes/${change}`);
	await clone.run("rm", "-q", path);
	await clone.run("commit", "-q", "-m", `${change}: delete ${path}`);
	await clone.run("push", "-q", "origin", `changes/${change}`);
	return clone.run("rev-parse", "HEAD");
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
const registryNow = async () =>
	(await new GitCasLog<Registry>(
		async () => ({ url: server.url, token: "unused" }),
		"p",
		"refs/notes/githive-claims/p",
	).read())!.commit.state;
const claimsNow = async () => (await registryNow()).claims;
const votesNow = async () =>
	(
		await new GitCasLog<Votes>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			"refs/notes/githive-votes/p",
		).read()
	)?.commit.state ?? { votes: [] };

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
	delete extra.landing;
	delete extra.mergeLimits;
	delete extra.batchGit;
	delete extra.runChecks;
});

/** Runs the job's steps until it's at `step` (or ended), without running that step. */
async function stepUntil(step: string) {
	for (let alarms = 0; alarms < 20; alarms++) {
		const job = (await sync.state()).job;
		if (!job || job.step === step || storage.alarm === null) return job;
		storage.alarm = null;
		await sync.alarm();
	}
	return (await sync.state()).job;
}

/** A change claimed, pushed and approved by agent a, ready to land; returns its head. */
async function ready(change: string, files: Record<string, string>) {
	await call("claim", { change, agent: "a", paths: Object.keys(files), intent: `Add ${change}` }, "a");
	const head = await pushChange(server.url, work, "a", change, files);
	await approve(head);
	return head;
}

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

	it("needs review for a squash onto a GitHub branch that moved on, so a deleted file can't return", async () => {
		await land("c-1", { "src/a.js": "a\n", "src/old.js": "old\n" });
		expect(await call("github_pr", {})).toMatchObject({ opened: true });
		// A commit of GitHub's own lands before the pull request is squashed.
		github.push({ "docs/notes.md": "from GitHub\n" });
		const merged = github.mergePull("squash");
		// GitHive deletes a file the pull request had: merged from git's own base, the squash would bring it back.
		await call("claim", { change: "c-2", agent: "a", paths: ["src/old.js"], intent: "Delete old" }, "a");
		await approve(await pushDeletion("c-2", "src/old.js"));
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		const job = await settle();
		expect(job).toMatchObject({ commit: merged, change: `github-${merged.slice(0, 12)}` });
		expect(job?.step).not.toBe("done");
		const [imported] = await imports();
		expect(imported).toMatchObject({ commit: merged, untrusted: expect.stringContaining("src/old.js") });
		// Nothing landed without review: the file stays deleted, and GitHub's commit isn't on main.
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/old.js");
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("docs/notes.md");
		const merge = { repo: "p", change: `github-${merged.slice(0, 12)}`, agent: GITHUB_AGENT };
		expect(await callTool("merge", merge, githubAgent())).toMatchObject({
			ok: false,
			reasons: [expect.stringContaining("approvals from reviewers")],
		});
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

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

	it("lets a person give up a stuck GitHub change, freeing its paths, until GitHub moves or they ask again", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const theirs = github.push({ "src/a.js": "from GitHub\n" });
		expect(await land("c-2", { "src/a.js": "from GitHive\n" })).toMatchObject({ step: "needs a person" });
		const change = `github-${theirs.slice(0, 12)}`;
		// Its claim holds src/a.js: an agent's claim on it is refused, and only its agent may release it.
		const claimA = { change: "c-3", agent: "a", paths: ["src/a.js"], intent: "Work on a" };
		expect(await call("claim", claimA, "a")).toMatchObject({ ok: false });
		await expect(call("release", { change, agent: "a" }, "a")).rejects.toThrow("a person who can write");
		// A person who can write gives it up from the dashboard.
		const { giveUpAsPerson, repoSnapshot } = await import("../src/toolkit/mcp");
		const person = "person:ana@example.com";
		const asPerson = { ...ctx(), stamper: async () => makeStamper(privateKey, person) };
		expect(await giveUpAsPerson(asPerson, "p", change, person)).toMatchObject({ ok: true, released: change });
		expect(await claimsNow()).toEqual([]);
		const released = (await registryNow()).released.at(-1);
		expect(released).toMatchObject({
			change,
			agent: GITHUB_AGENT,
			by: person,
			verifiedBy: person,
			stale: true,
			reason: `GitHub's changes given up by ${person}`,
		});
		expect((await sync.state()).job).toMatchObject({ step: "given up", change });
		expect((await repoSnapshot(ctx(), "p")).github?.fromGitHub).toMatchObject({ step: "given up" });
		// Its paths are free, and the audit accepts the release.
		expect(await call("claim", claimA, "a")).toMatchObject({ ok: true });
		await call("release", { change: "c-3", agent: "a" }, "a");
		expect(await call("audit", {})).toMatchObject({ open: 0 });
		// The next landing notices the same commit of GitHub's and starts nothing.
		await land("c-4", { "src/d.js": "d\n" });
		expect((await sync.state()).job).toMatchObject({ step: "given up" });
		expect(await claimsNow()).toEqual([]);
		// An agent's github_pr refresh doesn't take the give-up back.
		await call("github_pr", { refresh: true }, "a").catch(() => undefined);
		expect((await sync.state()).job).toMatchObject({ step: "given up" });
		expect(await claimsNow()).toEqual([]);
		// Asked again from the dashboard, it comes back, and conflicts as before.
		const { bringGitHubBackAgain } = await import("../src/toolkit/mcp");
		expect(await bringGitHubBackAgain(ctx(), "p")).toMatchObject({ fromGitHub: { step: "import", commit: theirs } });
		expect(await settle()).toMatchObject({ step: "needs a person", change });
		// People's question from before is still open: it isn't asked twice.
		const flags = (await votesNow()).flags ?? [];
		expect(flags.filter((flag) => flag.change === change)).toHaveLength(1);
		// Only GitHub's changes are given up this way.
		await call("claim", { ...claimA, change: "c-5", paths: ["src/e.js"] }, "a");
		await expect(giveUpAsPerson(asPerson, "p", "c-5", person)).rejects.toThrow("not GitHub's");
	});

	it("lets a repo admin give up GitHub's change through release, and no one else", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const theirs = github.push({ "src/a.js": "from GitHub\n" });
		expect(await land("c-2", { "src/a.js": "from GitHive\n" })).toMatchObject({ step: "needs a person" });
		const change = `github-${theirs.slice(0, 12)}`;
		const as = (level: "write" | "admin") => ({ ...ctx(keys.a), level });
		const release = { repo: "p", change, agent: "a" };
		await expect(callTool("release", release, as("write"))).rejects.toThrow("also a repo admin");
		expect(await callTool("release", release, as("admin"))).toMatchObject({ ok: true, released: change });
		expect((await registryNow()).released.at(-1)).toMatchObject({ change, agent: GITHUB_AGENT, by: "a", stale: true });
		expect((await sync.state()).job).toMatchObject({ step: "given up" });
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

	it("waits for its turn in steps no longer than its bound, and lands its own change alone", async () => {
		// One landing record for every merge, as the repo's is, so a lease held elsewhere makes the job's merge wait.
		const shared = memoryLanding();
		extra.landing = () => shared;
		extra.mergeLimits = { answerWithinMs: 200, pollMs: 50 };
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(await stepUntil("merge")).toMatchObject({ step: "merge", commit: pushed });
		// Another merge holds the lease: the job's merge answers pending within its bound, and its next alarm is set.
		expect(await shared.turn("someone", "x-1", "h".repeat(40), Date.now(), 60_000)).toEqual({ lease: true });
		const started = Date.now();
		storage.alarm = null;
		await sync.alarm();
		expect(Date.now() - started).toBeLessThan(10_000);
		expect((await sync.state()).job).toMatchObject({
			step: "merge",
			reason: expect.stringContaining("waits for its turn"),
		});
		expect(storage.alarm).not.toBeNull();
		// An approved change of agent a's is ready too, but the job's batch is its own change alone.
		const other = await ready("c-3", { "src/c.js": "c\n" });
		await shared.drop("someone");
		expect(await settle()).toMatchObject({ step: "done", commit: pushed });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/c.js");
		expect(await call("merge", { change: "c-3", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(lastMerge().parents[1]).toBe(other);
	});

	it("merges again shortly, however often others' merges land first, and never sends that to a person", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(await stepUntil("merge")).toMatchObject({ step: "merge" });
		// Main moves under every batch the job's merge builds, for more rounds than a step is tried.
		extra.batchGit = () => ({ ...memoryBatchGit({ url: server.url, token: "unused" }), land: async () => "moved" });
		for (let round = 0; round < 6; round++) {
			storage.alarm = null;
			await sync.alarm();
			expect((await sync.state()).job).toMatchObject({ step: "merge", reason: expect.stringContaining("kept moving") });
			expect(storage.alarm! - Date.now()).toBeGreaterThan(20_000);
		}
		delete extra.batchGit;
		expect(await settle()).toMatchObject({ step: "done", commit: pushed });
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
		await sync.notice({ repo: "p", github: "acme/shop", branch: "main", commit: github.head() }, "refresh");
		expect(await settle()).toMatchObject({ step: "done" });
		expect(server.git("show", "main:docs/notes.md")).toBe("from GitHub\n");
	});
});

describe("what can go wrong bringing GitHub's changes back", { timeout: 120_000 }, () => {
	it("sends a GitHub change whose checks fail to a person, landing nothing", async () => {
		extra.runChecks =
			() =>
			async ({ changes }) => {
				const github = changes.some((entry) => entry.change.startsWith("github-"));
				const output = github ? "1 failing: GitHub's change breaks the build" : "ok";
				return { passed: !github, results: [{ command: "npm test", exitCode: github ? 1 : 0, output }] };
			};
		await call("settings", { verify: ["npm test"] });
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "src/g.js": "from GitHub\n" });
		const job = await land("c-2", { "src/b.js": "b\n" });
		expect(job).toMatchObject({ step: "needs a person", commit: pushed, reason: expect.stringContaining("npm test") });
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/g.js");
		const change = `github-${pushed.slice(0, 12)}`;
		const shown = (await repoSnapshot(ctx(), "p")).claims.find((claim) => claim.change === change);
		expect(shown?.attention?.reason).toMatch(/^GitHub's changes need a person: .*npm test/);
		expect((await claimsNow()).map((claim) => claim.change)).toEqual([change]);
	});

	it("runs a GitHub change's checks on Actions when the repo does, and sends it to a person when they fail", async () => {
		github.close();
		let failing = false;
		const run = { id: 1, name: "test", status: "completed", url: "https://github.com/acme/shop/actions/runs/1" };
		github = await fakeGitHub(server, { runs: () => [{ ...run, conclusion: failing ? "failure" : "success" }] });
		await call("settings", { verify: ["github-actions"] });
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "src/g.js": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		// The workflow fails on the batch holding GitHub's change.
		failing = true;
		expect(await settle()).toMatchObject({ step: "needs a person", reason: expect.stringContaining("GitHub Actions") });
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/g.js");
		expect(github.calls.some((call) => call.startsWith("GET runs"))).toBe(true);
		// A fix pushed on GitHub is a new commit, checked afresh: passing, it lands, and the stuck change goes.
		failing = false;
		const fixed = github.push({ "src/g.js": "fixed on GitHub\n" });
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ step: "done", commit: fixed });
		expect(server.git("show", "main:src/g.js")).toBe("fixed on GitHub\n");
		expect(await claimsNow()).toEqual([]);
		expect(pushed).not.toBe(fixed);
	});

	it("finds its work done when a step dies after its claim, before the job noted it", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		const before = await stepUntil("claim");
		storage.alarm = null;
		await sync.alarm();
		expect((await sync.state()).job).toMatchObject({ step: "merge" });
		// The object lost what the step wrote: it claims again, which extends its claim, and goes on.
		await storage.put("job", before);
		await storage.setAlarm(Date.now());
		expect(await settle()).toMatchObject({ step: "done", commit: pushed });
		const brought = server.git("log", "--format=%s", "main").split("\n");
		expect(brought.filter((subject) => subject.startsWith("Bring in GitHub's changes"))).toHaveLength(1);
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("finds its work done when a step dies after its merge landed, before the job noted it", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		const before = await stepUntil("merge");
		storage.alarm = null;
		await sync.alarm();
		const landed = (await sync.state()).job;
		expect(landed).toMatchObject({ step: "done", merged: expect.any(String) });
		// Merged again, it answers with the commit it landed as, from its claim's release: nothing lands twice.
		await storage.put("job", before);
		await storage.setAlarm(Date.now());
		expect(await settle()).toMatchObject({ step: "done", commit: pushed, merged: landed!.merged });
		const brought = server.git("log", "--format=%s", "main").split("\n");
		expect(brought.filter((subject) => subject.startsWith("Bring in GitHub's changes"))).toHaveLength(1);
	});

	it("drops a step's outcome when a newer notice replaced its job meanwhile", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		const running = (await sync.state()).job!;
		expect(running).toMatchObject({ step: "import" });
		// While the import runs, the job is replaced (its alarm thought lost, say).
		const replaced = { ...running, commit: "f".repeat(40), noticedAt: new Date().toISOString() };
		const reach = extra.github!;
		extra.github = async (repo) => {
			await storage.put("job", replaced);
			return reach(repo);
		};
		try {
			storage.alarm = null;
			await sync.alarm();
		} finally {
			extra.github = reach;
		}
		expect((await sync.state()).job).toEqual(replaced);
	});

	it("lets the older GitHub change go when GitHub's branch moves on while it waits on a person", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const first = github.push({ "src/a.js": "from GitHub\n" });
		expect(await land("c-2", { "src/a.js": "from GitHive\n" })).toMatchObject({ step: "needs a person" });
		// GitHub moves on: the newer commit has the older one in it. On a commit of GitHub's own, and changing what
		// GitHive changed, it comes back for review.
		const second = github.push({ "docs/notes.md": "more from GitHub\n" });
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ step: "waiting", commit: second });
		expect((await claimsNow()).map((claim) => claim.change)).toEqual([`github-${second.slice(0, 12)}`]);
		const releases = (await registryNow()).released.filter(
			(release) => release.change === `github-${first.slice(0, 12)}`,
		);
		expect(releases.at(-1)).toMatchObject({ agent: GITHUB_AGENT, by: GITHUB_AGENT, reason: "GitHub's main moved on" });
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("can't bring in a GitHub branch sharing no history with main, and says so", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		// Someone replaces GitHub's main with an unrelated history.
		const tree = github.git("mktree").trim();
		const unrelated = github.git("commit-tree", "-m", "a new start", tree).trim();
		github.git("update-ref", "refs/heads/main", unrelated);
		const job = await land("c-2", { "src/b.js": "b\n" });
		expect(job).toMatchObject({ step: "failed", reason: expect.stringContaining("shares no history with main") });
		expect(await imports()).toEqual([]);
		expect(server.git("ls-tree", "--name-only", "-r", "main").trim().split("\n")).toEqual(["src/a.js", "src/b.js"]);
	});

	it("brings in what a force-pushed GitHub branch added, and drops nothing of GitHive's it left out", async () => {
		const start = github.head();
		await land("c-1", { "src/a.js": "a\n" });
		expect(await call("github_pr", {})).toMatchObject({ opened: true });
		github.mergePull("merge");
		expect(await land("c-2", { "src/b.js": "b\n" })).toMatchObject({ step: "done" });
		// GitHub's main is force-pushed back to before the pull request, with a commit of its own.
		const forced = github.forcePush(start, { "docs/notes.md": "rewritten on GitHub\n" });
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ step: "done", commit: forced });
		expect(server.git("show", "main:docs/notes.md")).toBe("rewritten on GitHub\n");
		expect(server.git("show", "main:src/a.js")).toBe("a\n");
		expect(server.git("show", "main:src/b.js")).toBe("b\n");
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});
});

describe("the merge path's trust rule, the audit's own", { timeout: 120_000 }, () => {
	/** A hosted context acting under githive- names, stamped as `identity`. */
	const hosted = (identity: string): ToolContext => {
		const { githubSync: _, ...rest } = ctx();
		return { ...rest, hosted: true, identity, stamper: async () => makeStamper(privateKey, identity) };
	};
	const mergeAs = (change: string, agent: string, as: ToolContext) =>
		callTool("merge", { repo: "p", change, agent }, as) as Promise<Record<string, unknown>>;
	const needsVotes = { ok: false, reasons: [expect.stringContaining("approvals from reviewers")] };

	/** GitHub's commit pushed there and imported by the job, which stops before it claims. */
	async function imported() {
		await land("c-1", { "src/a.js": "a\n" });
		const pushed = github.push({ "docs/notes.md": "from GitHub\n" });
		await ready("c-2", { "src/b.js": "b\n" });
		expect(await call("merge", { change: "c-2", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(await stepUntil("claim")).toMatchObject({ step: "claim" });
		return { pushed, change: `github-${pushed.slice(0, 12)}` };
	}

	it("lets no hosted agent but GitHive's GitHub job act as githive-github", async () => {
		const { change } = await imported();
		const builder = hosted("service:githive-builder");
		const claim = { repo: "p", change, agent: GITHUB_AGENT, source: "github/main", intent: "Bring it in" };
		await expect(callTool("claim", claim, builder)).rejects.toThrow("only GitHive's GitHub job acts as githive-github");
		const release = { repo: "p", change, agent: GITHUB_AGENT, reason: "not needed" };
		await expect(callTool("release", release, builder)).rejects.toThrow("only GitHive's GitHub job");
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("docs/notes.md");
	});

	it("needs votes for a change of GitHub's not named for the import it brings in", async () => {
		await imported();
		const claim = {
			repo: "p",
			change: "github-other",
			agent: GITHUB_AGENT,
			source: "github/main",
			intent: "Bring it in",
		};
		expect(await callTool("claim", claim, githubAgent())).toMatchObject({ ok: true });
		expect(await mergeAs("github-other", GITHUB_AGENT, githubAgent())).toMatchObject(needsVotes);
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("docs/notes.md");
	});

	it("needs votes for an older import claimed again once a newer one came in", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		const first = github.push({ "src/a.js": "from GitHub\n" });
		expect(await land("c-2", { "src/a.js": "from GitHive\n" })).toMatchObject({ step: "needs a person" });
		const second = github.push({ "docs/notes.md": "more from GitHub\n" });
		expect(await land("c-3", { "src/c.js": "c\n" })).toMatchObject({ commit: second });
		expect((await imports()).map((entry) => entry.commit)).toEqual([first, second]);
		// The older import, which never landed, is pointed at again and claimed as GitHub's job would.
		const job = githubAgent();
		const newer = { repo: "p", change: `github-${second.slice(0, 12)}`, agent: GITHUB_AGENT, reason: "replayed" };
		await callTool("release", newer, job);
		server.git("update-ref", "refs/heads/github/main", first);
		const older = `github-${first.slice(0, 12)}`;
		const claim = { repo: "p", change: older, agent: GITHUB_AGENT, source: "github/main", intent: "Bring it in" };
		expect(await callTool("claim", claim, job)).toMatchObject({ ok: true });
		expect(await mergeAs(older, GITHUB_AGENT, job)).toMatchObject({
			ok: false,
			reasons: expect.arrayContaining([expect.stringContaining("approvals from reviewers")]),
		});
	});

	it("needs votes for a head the import record doesn't hold", async () => {
		await imported();
		// github/main moves to a commit no import wrote, before githive-github claims it.
		const tip = server.git("rev-parse", "github/main").trim();
		const other = server.git("commit-tree", "-p", tip, "-m", "not imported", `${tip}^{tree}`).trim();
		server.git("update-ref", "refs/heads/github/main", other);
		expect(await settle()).toMatchObject({ step: "waiting", reason: expect.stringContaining("waits for review") });
		expect(server.git("ls-tree", "--name-only", "-r", "main")).not.toContain("docs/notes.md");
	});

	it("needs votes once the repo is connected to another GitHub repo than the import came from", async () => {
		const { change } = await imported();
		expect(await stepUntil("merge")).toMatchObject({ step: "merge", change });
		const reach = extra.github!;
		extra.github = async (repo) => (repo === "acme/other" ? github.link : reach(repo));
		try {
			await call("settings", { github: "acme/other" });
			expect(await mergeAs(change, GITHUB_AGENT, hosted(GITHUB_IDENTITY))).toMatchObject(needsVotes);
		} finally {
			extra.github = reach;
		}
	});

	it("needs votes for another agent's claim of GitHub's branch, however it got into the records", async () => {
		await imported();
		const log = new GitCasLog<Registry>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			"refs/notes/githive-claims/p",
		);
		const head = (await log.read())!;
		const at = new Date().toISOString();
		const forged = { change: "x-1", agent: "a", paths: ["docs/"], intent: "GitHub's", since: at, active: at };
		await log.append(head.tip, {
			author: "a",
			kind: "decisions",
			entries: [{ commit: "none", text: "a claim written by hand", at }],
			state: { ...head.commit.state, claims: [...head.commit.state.claims, { ...forged, source: "github/main" }] },
			batch: crypto.randomUUID(),
		});
		await pushChange(server.url, work, "a", "x-1", { "docs/notes.md": "from GitHub\n" });
		expect(await call("merge", { change: "x-1", agent: "a" }, "a")).toMatchObject(needsVotes);
	});
});

describe("GitHive's copies of GitHub's branches", { timeout: 120_000 }, () => {
	const tryCall = (name: string, args: Record<string, unknown>, as?: string) =>
		call(name, args, as).then(
			() => "done",
			(err: Error) => err.message,
		);

	it("are reserved: no change lands on or starts from github/<branch>, and only githive-github merges one", async () => {
		await land("c-1", { "src/a.js": "a\n" });
		github.push({ "docs/notes.md": "from GitHub\n" });
		await call("settings", { github_trust: false });
		// The job brings GitHub's commit in as github/main, and waits for review.
		expect(await land("c-2", { "src/b.js": "b\n" })).toMatchObject({ step: "waiting" });
		const claim = { agent: "a", paths: ["src/x.js"], intent: "Work on GitHub's copy" };
		expect(await tryCall("claim", { ...claim, change: "x-1", into: "github/main", from: "main" }, "a")).toMatch(
			"github/main: branches under github/ are GitHive's copies of GitHub's",
		);
		expect(await tryCall("claim", { ...claim, change: "x-2", into: "feature/x", from: "github/main" }, "a")).toMatch(
			"github/main: branches under github/ are GitHive's copies of GitHub's",
		);
		expect(await tryCall("claim", { ...claim, change: "x-3", source: "github/main" }, "a")).toMatch(
			"github/main: only githive-github merges GitHive's copies of GitHub's branches",
		);
		const { makeBranch } = await import("../src/toolkit/mcp");
		await expect(
			makeBranch(ctx(), "p", { name: "github/other", from: "main" }, "person:ana@example.com"),
		).rejects.toThrow("branches under github/ are GitHive's copies of GitHub's");
		expect(server.git("branch", "--list", "github/*").trim().split(/\s+/)).toEqual(["github/main"]);
		expect((await claimsNow()).map((held) => held.change)).toEqual([expect.stringMatching(/^github-/)]);
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
		expect(noticed(null, null, seen, "p", undefined, now)).toMatchObject({ step: "import", commit: "c1" });
		// Known to be on main.
		expect(noticed(null, "c1", seen, "p", undefined, now)).toBeNull();
		// One runs: it fetches GitHub's newest anyway.
		expect(noticed(job("merge", "c0"), null, seen, "p", undefined, now)).toBeNull();
		// Unless it lost its alarm long ago.
		expect(noticed(job("merge", "c0", 61), null, seen, "p", undefined, now)).toMatchObject({ commit: "c1" });
		// Brought back, or sent to a person: not again for the same commit, unless asked.
		expect(noticed(job("done"), null, seen, "p", undefined, now)).toBeNull();
		expect(noticed(job("needs a person"), null, seen, "p", undefined, now)).toBeNull();
		expect(noticed(job("needs a person"), null, seen, "p", "refresh", now)).toMatchObject({ step: "import" });
		// Given up, only a person asking again takes it back: an agent's refresh doesn't.
		expect(noticed(job("given up"), null, seen, "p", undefined, now)).toBeNull();
		expect(noticed(job("given up"), null, seen, "p", "refresh", now)).toBeNull();
		expect(noticed(job("given up"), null, seen, "p", "person", now)).toMatchObject({ step: "import" });
		expect(noticed(job("given up", "c0"), null, seen, "p", undefined, now)).toMatchObject({ commit: "c1" });
		// A newer commit starts again.
		expect(noticed(job("needs a person", "c0"), null, seen, "p", undefined, now)).toMatchObject({ commit: "c1" });
		// A job that waited goes on from where it waited, its import done.
		const waited = { ...job("waiting"), resume: "claim" as const, reason: "paths held", head: "h1" };
		expect(noticed(waited, null, seen, "p", undefined, now)).toMatchObject({ step: "claim", head: "h1" });
		expect(noticed(waited, null, seen, "p", undefined, now)).not.toHaveProperty("reason");
		// A job that failed starts again only after a while, or when asked.
		expect(noticed(job("failed", "c1", 5), null, seen, "p", undefined, now)).toBeNull();
		expect(noticed(job("failed", "c1", 5), null, seen, "p", "refresh", now)).toMatchObject({ step: "import" });
		expect(noticed(job("failed", "c1", 61), null, seen, "p", undefined, now)).toMatchObject({ step: "import" });
	});
});
