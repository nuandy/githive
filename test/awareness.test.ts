import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awareness, type AwarenessParts, type ClaimView } from "../src/awareness";
import { notePushEvents, type PushedEvent, type RepoPushes } from "../src/push-events";
import type { Notice } from "../src/repo-cache";
import { forgetChains } from "../src/toolkit/batch-reads";
import { FakeStorage } from "./fakes/env";
import { agentClone } from "./helpers/agents";
import { SETTINGS_TS, SIGNATURE_CHANGE, USES_LOAD } from "./helpers/footprints";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";

const { RepoCache } = await import("../src/repo-cache");
const { FootprintCache } = await import("../src/footprint-cache");

// Awareness from push events, end to end over real git: a change pushed to its agent's fork is footprinted against
// its base, a push to the project's branch tells the open changes that use what it altered, and two open changes
// that alter and use the same name both hear of it. The queue's messages are simulated, as Artifacts would send them.

const BODY_ONLY = SETTINGS_TS.replace("return { timeout: path.length };", "return { timeout: path.length * 2 };");
const SYNC = "export function sync() {\n  return 1;\n}\n";
const INTENT_C7 = "return a Result from loadSettings";
const SAYS_C9_USES =
	"your change imports `loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; its interface " +
	"changed from `export function loadSettings(path: string): Settings` to " +
	"`export function loadSettings(path: string): Result<Settings>`";

let server: GitServer;
let work: string;

beforeEach(async () => {
	// Branch chains are cached per isolate by repo name, and every test's project is "project".
	forgetChains();
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-awareness-"));
	const setup = await agentClone(server.url, work, "setup");
	setup.write("src/config.ts", SETTINGS_TS);
	setup.write("src/jobs/sync.ts", SYNC);
	await setup.run("add", "-A");
	await setup.run("commit", "--quiet", "-m", "Start");
	await setup.run("push", "--quiet", "origin", "main");
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/** The hive's caches, the parts awareness reads through, and push events delivered as a queue batch. */
function hive() {
	const repoCache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
	const storage = new FakeStorage();
	const footprints = new FootprintCache(
		{ storage, getWebSockets: () => [] } as never,
		{ REPO_CACHE: { getByName: () => repoCache } } as never,
	);
	const claims: ClaimView[] = [];
	const parts: AwarenessParts = {
		history: (repo, read) => gitHistory((...args) => server.gitIn(repo, ...args))(repo, read),
		claims: async () => ({ branch: "main", claims }),
		branchHead: async (repo, branch) => server.gitIn(repo, "rev-parse", branch).trim(),
		forkOf: async (repo, agent) => `fork--${repo}--agent--${agent}`,
		footprints,
	};
	const env = { ARTIFACTS_NAMESPACE: "blueprint", REPO_CACHE: { getByName: () => repoCache } } as unknown as Env;
	let clock = Date.parse("2026-10-11T12:00:00.000Z");
	const event = (repoName: string, ref: string, after: string, before?: string): PushedEvent => ({
		type: "cf.artifacts.repo.pushed",
		source: { namespace: "blueprint", repoName },
		payload: { ref, after, ...(before ? { before } : {}) },
		metadata: { eventTimestamp: new Date((clock += 1_000)).toISOString() },
	});
	const deliver = async (...bodies: PushedEvent[]) => {
		const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
		// As each repo's FootprintCache would, given its pushes.
		const handOff = (repo: string, pushes: RepoPushes) => awareness(repo, pushes, parts);
		await notePushEvents({ messages } as unknown as MessageBatch<unknown>, env, handOff);
		return messages;
	};
	return {
		repoCache,
		footprints,
		storage,
		claims,
		parts,
		env,
		deliver,
		forkPush: (agent: string, change: string, head: string) =>
			event(`fork--project--agent--${agent}`, `refs/heads/changes/${change}`, head),
		branchPush: (branch: string, moved: { before: string; after: string }, before = true) =>
			event("project", `refs/heads/${branch}`, moved.after, before ? moved.before : undefined),
		/** What an agent's next reply would tell it: its notices, on every branch. */
		told: async (agent: string) =>
			(await repoCache.landingNews("main", agent)).filter((item): item is Notice => item.kind !== "landed"),
	};
}

/** Pushes changes/<change> with these files to the agent's fork, built on `from` (replacing any), and returns its head. */
async function pushToFork(agent: string, change: string, files: Record<string, string>, from = "main") {
	const clone = await agentClone(server.url, work, `${agent}-${change}-${Math.random().toString(36).slice(2, 8)}`);
	await clone.run("checkout", "--quiet", "-b", `changes/${change}`, `origin/${from}`);
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", `${change}: work`);
	await clone.run(
		"push",
		"--quiet",
		"--force",
		server.repo(`fork--project--agent--${agent}`),
		`HEAD:refs/heads/changes/${change}`,
	);
	return clone.run("rev-parse", "HEAD");
}

/** Lands a change on `branch` as GitHive does: a merge commit with its trailers, whose first parent is the branch. */
async function land(change: string, agent: string, files: Record<string, string>, intent?: string, branch = "main") {
	const clone = await agentClone(server.url, work, `land-${change}-${Math.random().toString(36).slice(2, 8)}`);
	await clone.run("checkout", "--quiet", "-B", branch, `origin/${branch}`);
	const before = await clone.run("rev-parse", "HEAD");
	await clone.run("checkout", "--quiet", "-b", `changes/${change}`);
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", `${change}: work`);
	await clone.run("checkout", "--quiet", branch);
	const trailers = [
		`GitHive-Change: ${change}`,
		`GitHive-Agent: ${agent}`,
		...(intent ? [`GitHive-Intent: ${intent}`] : []),
	];
	const message = `${intent ?? `Merge ${change} by ${agent}`}\n\nMerge ${change} by ${agent}.\n\n${trailers.join("\n")}`;
	await clone.run("merge", "--quiet", "--no-ff", "-m", message, `changes/${change}`);
	await clone.run("push", "--quiet", "origin", branch);
	return { before, after: await clone.run("rev-parse", "HEAD") };
}

/** A commit pushed straight to main with plain git. */
async function plainPush(author: string, subject: string, files: Record<string, string>) {
	const clone = await agentClone(server.url, work, `plain-${Math.random().toString(36).slice(2, 8)}`);
	const before = await clone.run("rev-parse", "HEAD");
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", `--author=${author} <someone@example.com>`, "-m", subject);
	await clone.run("push", "--quiet", "origin", "main");
	return { before, after: await clone.run("rev-parse", "HEAD") };
}

describe("interface news when the branch moves", () => {
	it("tells an open change that uses a name whose interface just landed changed", async () => {
		const { claims, deliver, forkPush, branchPush, told, repoCache, footprints } = hive();
		claims.push({ change: "c-9", agent: "bob", intent: "sync settings" });
		const head = await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD });
		const pushed = await deliver(forkPush("bob", "c-9", head));
		expect(pushed[0]!.ack).toHaveBeenCalledOnce();
		expect(await footprints.keptHead("c-9")).toMatchObject({ head });
		const moved = await land("c-7", "alice", { "src/config.ts": SIGNATURE_CHANGE }, INTENT_C7);
		await deliver(branchPush("main", moved));
		expect(await told("bob")).toEqual([
			{
				kind: "interface",
				at: expect.any(String),
				says: `alice landed c-7 ("${INTENT_C7}"): ${SAYS_C9_USES}`,
				next: "Merge the branch into yours and update those uses before you merge: git fetch origin main && git merge origin/main.",
				change: "c-9",
				branch: "main",
				from: { agent: "alice", change: "c-7" },
				detail: { commit: moved.after, names: ["loadSettings"] },
			},
		]);
		expect(await repoCache.events()).toContainEqual({
			kind: "interface",
			agent: "alice",
			change: "c-9",
			other: "bob",
			commit: moved.after,
			detail: "loadSettings",
			at: expect.any(String),
		});
		// The same event again tells nothing new.
		await deliver(branchPush("main", moved));
		expect(await told("bob")).toEqual([]);
	});

	it("names a plain-git push by its author", async () => {
		const { claims, deliver, forkPush, branchPush, told } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		const moved = await plainPush("Jane Doe", "loadSettings returns a Result", { "src/config.ts": SIGNATURE_CHANGE });
		await deliver(branchPush("main", moved));
		expect(await told("bob")).toMatchObject([
			{
				kind: "interface",
				says: `Jane Doe pushed ${moved.after.slice(0, 7)} ("loadSettings returns a Result"): ${SAYS_C9_USES}`,
				from: { agent: "Jane Doe" },
			},
		]);
	});

	it("takes GitHive's trailers only from a merge commit: a plain push that writes them is its author's", async () => {
		const { claims, deliver, forkPush, branchPush, told, footprints } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		const message = "loadSettings returns a Result\n\nGitHive-Change: c-9\nGitHive-Agent: alice";
		const moved = await plainPush("Jane Doe", message, { "src/config.ts": SIGNATURE_CHANGE });
		await deliver(branchPush("main", moved));
		// c-9's footprint stays, and the notice names who pushed, not the agent the trailers name.
		expect(await footprints.keptHead("c-9")).not.toBeNull();
		expect(await told("bob")).toMatchObject([{ kind: "interface", from: { agent: "Jane Doe" } }]);
	});

	it("says nothing for a body-only change", async () => {
		const { claims, deliver, forkPush, branchPush, told, repoCache } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		await deliver(branchPush("main", await land("c-7", "alice", { "src/config.ts": BODY_ONLY }, "double it")));
		expect(await told("bob")).toEqual([]);
		expect((await repoCache.events()).filter((event) => event.kind === "interface")).toEqual([]);
	});

	it("a file that doesn't parse is skipped, and nothing fails", async () => {
		const { claims, deliver, forkPush, branchPush, told, footprints } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		const uses =
			'import { loadSettings } from "../config";\nimport { helper } from "../util";\n\nexport const a = loadSettings("x");\nexport const b = helper(1);\n';
		const setup = await land("c-0", "carol", {
			"src/util.ts": "export function helper(n: number): number {\n  return n;\n}\n",
		});
		await deliver(branchPush("main", setup));
		const head = await pushToFork("bob", "c-9", {
			"src/jobs/sync.ts": uses,
			"src/jobs/broken.ts": "export function (",
		});
		const pushed = await deliver(forkPush("bob", "c-9", head));
		expect(pushed[0]!.ack).toHaveBeenCalledOnce();
		expect(await footprints.keptHead("c-9")).toMatchObject({ head });
		// The landing breaks config.ts, and changes helper's interface: only helper is told.
		const moved = await land("c-7", "alice", {
			"src/config.ts": "export function loadSettings(path: string): Settings {",
			"src/util.ts": "export function helper(n: string): number {\n  return n.length;\n}\n",
		});
		const messages = await deliver(branchPush("main", moved));
		expect(messages[0]!.ack).toHaveBeenCalledOnce();
		const notices = await told("bob");
		expect(notices).toHaveLength(1);
		expect(notices[0]!.detail).toEqual({ commit: moved.after, names: ["helper"] });
		expect(notices[0]!.says).toContain("imports `helper` from `src/util.ts` and uses it at `src/jobs/sync.ts:5`");
	});

	it("the landed change's footprint is dropped", async () => {
		const { claims, deliver, forkPush, branchPush, footprints, told } = hive();
		claims.push({ change: "c-7", agent: "alice", intent: INTENT_C7 }, { change: "c-9", agent: "bob" });
		await deliver(
			forkPush("alice", "c-7", await pushToFork("alice", "c-7", { "src/config.ts": SIGNATURE_CHANGE })),
			forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })),
		);
		expect(await footprints.keptHead("c-7")).not.toBeNull();
		await told("bob");
		await deliver(branchPush("main", await land("c-7", "alice", { "src/config.ts": SIGNATURE_CHANGE }, INTENT_C7)));
		expect(await footprints.keptHead("c-7")).toBeNull();
		expect(await footprints.keptHead("c-9")).not.toBeNull();
		expect((await told("bob")).map((notice) => notice.kind)).toEqual(["interface"]);
	});

	it("notices for a change into a feature branch reach its agent", async () => {
		const { claims, deliver, forkPush, branchPush, told } = hive();
		const setup = await agentClone(server.url, work, "feature");
		await setup.run("push", "--quiet", "origin", "main:feature");
		claims.push({ change: "c-9", agent: "bob", into: "feature" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD }, "feature")));
		const moved = await land("c-7", "alice", { "src/config.ts": SIGNATURE_CHANGE }, INTENT_C7, "feature");
		// Main moving tells nothing: the change goes into feature.
		await deliver(branchPush("main", await plainPush("Jane Doe", "readme", { "README.md": "hi\n" })));
		await deliver(branchPush("feature", moved));
		// Told in a reply about the project's branch, which is where every reply's news comes from.
		expect(await told("bob")).toMatchObject([
			{
				kind: "interface",
				branch: "feature",
				says: `alice landed c-7 ("${INTENT_C7}"): ${SAYS_C9_USES}`,
				next: "Merge the branch into yours and update those uses before you merge: git fetch origin feature && git merge origin/feature.",
			},
		]);
	});

	it("reads nothing while no open change goes into the branch, and analyses at most 50 commits a push", async () => {
		const { claims, deliver, forkPush, branchPush, told, parts, footprints } = hive();
		const history = vi.spyOn(parts, "history");
		await deliver(branchPush("main", await land("c-1", "alice", { "src/config.ts": SIGNATURE_CHANGE }, "x")));
		expect(history).not.toHaveBeenCalled();
		history.mockRestore();
		claims.push({ change: "c-9", agent: "bob" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		// An altering commit, then 50 more: the push is analysed for its newest 50, which alter nothing.
		const clone = await agentClone(server.url, work, "many");
		const before = await clone.run("rev-parse", "HEAD");
		clone.write(
			"src/config.ts",
			SETTINGS_TS.replace("(path: string): Settings", "(path: string, again: boolean): Settings"),
		);
		await clone.run("commit", "--quiet", "-am", "alter loadSettings");
		for (let i = 0; i < 50; i++) await clone.run("commit", "--quiet", "--allow-empty", "-m", `empty ${i}`);
		await clone.run("push", "--quiet", "origin", "main");
		const after = await clone.run("rev-parse", "HEAD");
		const landed = vi.spyOn(footprints, "landed");
		await deliver(branchPush("main", { before, after }));
		expect(landed.mock.calls[0]![2]).toHaveLength(50);
		expect(await told("bob")).toEqual([]);
	});
});

describe("heads-ups between open changes", () => {
	const SAYS_FOR_BOB =
		`alice's change c-7 ("${INTENT_C7}") alters code your change uses, not landed yet: your change imports ` +
		"`loadSettings` from `src/config.ts` and uses it at `src/jobs/sync.ts:4`; their change alters its interface " +
		"from `export function loadSettings(path: string): Settings` to " +
		"`export function loadSettings(path: string): Result<Settings>`";
	const SAYS_FOR_ALICE =
		'bob\'s change c-9 ("sync settings") uses code your change alters: their change imports `loadSettings` from ' +
		"`src/config.ts` and uses it at `src/jobs/sync.ts:4`; your change alters its interface from " +
		"`export function loadSettings(path: string): Settings` to " +
		"`export function loadSettings(path: string): Result<Settings>`";

	it("two open changes, one altering a name the other uses, both hear a heads-up, once", async () => {
		const { claims, deliver, forkPush, told, repoCache } = hive();
		claims.push(
			{ change: "c-7", agent: "alice", intent: INTENT_C7 },
			{ change: "c-9", agent: "bob", intent: "sync settings" },
		);
		const alice = forkPush("alice", "c-7", await pushToFork("alice", "c-7", { "src/config.ts": SIGNATURE_CHANGE }));
		const bob = forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD }));
		await deliver(alice, bob);
		expect(await told("bob")).toEqual([
			{
				kind: "heads_up",
				at: expect.any(String),
				says: SAYS_FOR_BOB,
				next: "Nothing has landed yet: see what c-7 is for in its claim's intent, and update those uses if it lands first.",
				change: "c-9",
				branch: "main",
				from: { agent: "alice", change: "c-7" },
				detail: { names: ["loadSettings"] },
			},
		]);
		expect(await told("alice")).toEqual([
			{
				kind: "heads_up",
				at: expect.any(String),
				says: SAYS_FOR_ALICE,
				next: "Nothing has landed yet: keep what c-9 uses working, or it will need updating once yours lands.",
				change: "c-7",
				branch: "main",
				from: { agent: "bob", change: "c-9" },
				detail: { names: ["loadSettings"] },
			},
		]);
		const headsUps = (await repoCache.events()).filter((event) => event.kind === "heads_up");
		expect(headsUps).toEqual([
			{
				kind: "heads_up",
				agent: "alice",
				change: "c-7",
				other: "bob",
				otherChange: "c-9",
				detail: "loadSettings",
				at: expect.any(String),
			},
		]);
		// The same pushes again, in either order: nothing more.
		await deliver(bob, alice);
		expect([await told("bob"), await told("alice")]).toEqual([[], []]);
	});

	it("a newer head replaces the footprint, and a heads-up is told again only when the alteration changes", async () => {
		const { claims, deliver, forkPush, told, footprints } = hive();
		claims.push(
			{ change: "c-7", agent: "alice", intent: INTENT_C7 },
			{ change: "c-9", agent: "bob", intent: "sync settings" },
		);
		const first = forkPush("alice", "c-7", await pushToFork("alice", "c-7", { "src/config.ts": SIGNATURE_CHANGE }));
		await deliver(first, forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		await told("bob");
		await told("alice");
		// A newer push with only a body change keeps the same alteration: nothing new to tell.
		const bodyOnly = SIGNATURE_CHANGE.replace("path.length", "path.length + 1");
		const newer = await pushToFork("alice", "c-7", { "src/config.ts": bodyOnly });
		await deliver(forkPush("alice", "c-7", newer));
		expect(await footprints.keptHead("c-7")).toMatchObject({ head: newer });
		expect([await told("bob"), await told("alice")]).toEqual([[], []]);
		// A different signature is a different alteration, told again.
		const reshaped = bodyOnly.replace("Result<Settings>", "Promise<Settings>");
		const newest = await pushToFork("alice", "c-7", { "src/config.ts": reshaped });
		await deliver(forkPush("alice", "c-7", newest));
		expect((await told("bob")).map((notice) => notice.says)).toEqual([
			SAYS_FOR_BOB.replace("Result<Settings>", "Promise<Settings>"),
		]);
		expect((await told("alice")).map((notice) => notice.says)).toEqual([
			SAYS_FOR_ALICE.replace("Result<Settings>", "Promise<Settings>"),
		]);
		// The older push's event, late: it replaces nothing and tells nothing.
		await deliver(first);
		expect(await footprints.keptHead("c-7")).toMatchObject({ head: newest });
		expect([await told("bob"), await told("alice")]).toEqual([[], []]);
	});

	it("fails a batch's pushes fast once its reads run out, and footprints the change at its next push", async () => {
		const { claims, deliver, forkPush, footprints, parts } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		parts.budget = { reads: 0 };
		const first = await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD });
		const messages = await deliver(forkPush("bob", "c-9", first));
		expect(messages[0]!.ack).toHaveBeenCalledOnce();
		expect(await footprints.keptHead("c-9")).toBeNull();
		expect(errors).toHaveBeenCalledWith(
			expect.stringMatching(/^awareness: footprinting c-9 .* this batch's 0 Artifacts reads for awareness ran out/),
		);
		// Nothing retries it: it's footprinted when its agent pushes again.
		delete parts.budget;
		const second = await pushToFork("bob", "c-9", { "src/jobs/sync.ts": `${USES_LOAD}\n` });
		await deliver(forkPush("bob", "c-9", second));
		expect(await footprints.keptHead("c-9")).toMatchObject({ head: second });
		errors.mockRestore();
	});

	it("caps a batch's reads of the project's own repo, which merges read too, below its reads of forks", async () => {
		const { claims, deliver, forkPush, footprints, parts } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		parts.budget = { projectReads: 0 };
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		expect(await footprints.keptHead("c-9")).toBeNull();
		expect(errors).toHaveBeenCalledWith(
			expect.stringMatching(/^awareness: footprinting c-9 .* this batch's 0 reads of project for awareness ran out/),
		);
		errors.mockRestore();
	});

	it("stops a batch once Artifacts says the project is busy, leaving the rest for the next push", async () => {
		const { claims, deliver, forkPush, branchPush, footprints, parts } = hive();
		claims.push({ change: "c-9", agent: "bob" }, { change: "c-5", agent: "carol" });
		await deliver(forkPush("bob", "c-9", await pushToFork("bob", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		const moved = await land("c-7", "alice", { "src/config.ts": SIGNATURE_CHANGE }, INTENT_C7);
		const carol = forkPush("carol", "c-5", await pushToFork("carol", "c-5", { "src/jobs/other.ts": USES_LOAD }));
		const history = parts.history;
		const busy = Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR" });
		const reads = vi.fn(async () => Promise.reject(busy));
		parts.history = reads;
		const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await deliver(branchPush("main", moved), carol);
		// The branch's first read was refused; carol's push wasn't read at all.
		expect(reads).toHaveBeenCalledOnce();
		expect(logs).toHaveBeenCalledWith("awareness: Artifacts is busy; 1 of project's pushes left for the next push");
		expect(await footprints.keptHead("c-5")).toBeNull();
		// Nothing retries it: carol's next push is read once the project isn't busy.
		parts.history = history;
		await deliver(
			forkPush("carol", "c-5", await pushToFork("carol", "c-5", { "src/jobs/other.ts": `${USES_LOAD}\n` })),
		);
		expect(await footprints.keptHead("c-5")).not.toBeNull();
		logs.mockRestore();
		errors.mockRestore();
	});

	it("ignores a push to a change's branch on a fork other than its claim holder's, and a change nobody claims", async () => {
		const { claims, deliver, forkPush, footprints } = hive();
		claims.push({ change: "c-9", agent: "bob" });
		await deliver(forkPush("mallory", "c-9", await pushToFork("mallory", "c-9", { "src/jobs/sync.ts": USES_LOAD })));
		await deliver(forkPush("bob", "c-1", await pushToFork("bob", "c-1", { "src/jobs/sync.ts": USES_LOAD })));
		expect([await footprints.keptHead("c-9"), await footprints.keptHead("c-1")]).toEqual([null, null]);
	});
});

describe("a full batch", { timeout: 60_000 }, () => {
	it("reads no more for 100 events, with redeliveries, duplicates and strangers' pushes, than for each push once", async () => {
		const changes = ["c-0", "c-1", "c-2", "c-3", "c-4"];
		const heads: Record<string, string> = {};
		for (const [i, change] of changes.entries())
			heads[change] = await pushToFork(`agent-${i}`, change, { [`src/jobs/job${i}.ts`]: USES_LOAD });
		const stranger = await pushToFork("mallory", "c-0", { "src/jobs/x.ts": USES_LOAD });
		const moved = await land("c-7", "alice", { "src/config.ts": SIGNATURE_CHANGE }, INTENT_C7);
		/** Delivers the batches to a fresh hive, counting Artifacts reads. */
		const readsFor = async (...batches: ((h: ReturnType<typeof hive>) => PushedEvent[])[]) => {
			forgetChains();
			const h = hive();
			h.claims.push(...changes.map((change, i) => ({ change, agent: `agent-${i}` })));
			const reads = { count: 0 };
			const history = h.parts.history;
			h.parts.history = (repo, read) =>
				history(repo, (source) => {
					const spend = <T>(made: Promise<T>) => (reads.count++, made);
					return read({
						log: (ref, limit, offset) => spend(source.log(ref, limit, offset)),
						readCommit: (hash) => spend(source.readCommit(hash)),
						readTree: (hash) => spend(source.readTree(hash)),
						...(source.readBlob ? { readBlob: (hash: string) => spend(source.readBlob!(hash)) } : {}),
					});
				});
			for (const batch of batches) {
				const messages = await h.deliver(...batch(h));
				for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
			}
			return { reads: reads.count, told: (await Promise.all(changes.map((_, i) => h.told(`agent-${i}`)))).flat() };
		};
		const pushes = (h: ReturnType<typeof hive>) =>
			changes.map((change, i) => h.forkPush(`agent-${i}`, change, heads[change]!));
		const once = await readsFor(pushes, (h) => [h.branchPush("main", moved)]);
		// 85 events, then 15: each push delivered ten times, pushes by strangers, and one landing told fifteen times.
		const crowded = await readsFor(
			(h) => {
				const events: PushedEvent[] = [];
				for (let round = 0; round < 10; round++) events.push(...pushes(h));
				// Pushes to a change's branch on a fork that isn't its holder's, and to changes nobody claims.
				for (let i = 0; i < 30; i++) events.push(h.forkPush("mallory", "c-0", stranger));
				for (let i = 0; i < 5; i++) events.push(h.forkPush("mallory", `m-${i}`, stranger));
				return events;
			},
			(h) => Array.from({ length: 15 }, () => h.branchPush("main", moved)),
		);
		expect(crowded.reads).toBe(once.reads);
		expect(crowded.told.map((notice) => notice.change).sort()).toEqual(once.told.map((notice) => notice.change).sort());
		expect(once.told).toHaveLength(5);
	});
});

describe("the queue consumer with awareness", () => {
	it("noting heads still works when the awareness work throws", async () => {
		const notePushes = vi.fn(async () => undefined);
		const env = {
			ARTIFACTS_NAMESPACE: "blueprint",
			REPO_CACHE: { getByName: () => ({ notePushes }) },
		} as unknown as Env;
		const handOff = vi.fn(async () => {
			throw new Error("FootprintCache is overloaded");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const at = "2026-10-11T12:00:00.000Z";
		const body = (repoName: string, ref: string) => ({
			type: "cf.artifacts.repo.pushed",
			source: { namespace: "blueprint", repoName },
			payload: { ref, before: "b".repeat(40), after: "a".repeat(40) },
			metadata: { eventTimestamp: at },
		});
		const messages = [body("fork--p--agent--a", "refs/heads/changes/c"), body("p", "refs/heads/main")].map((each) => ({
			body: each,
			ack: vi.fn(),
			retry: vi.fn(),
		}));
		await notePushEvents({ messages } as unknown as MessageBatch<unknown>, env, handOff);
		// The fork's push and the branch's are the same project's, so they go to its FootprintCache together.
		expect(handOff).toHaveBeenCalledExactlyOnceWith("p", {
			moved: [expect.objectContaining({ repo: "p", branch: "main" })],
			pushed: [expect.objectContaining({ change: "c" })],
		});
		expect(notePushes).toHaveBeenCalledWith([
			{ change: "c", fork: "fork--p--agent--a", head: "a".repeat(40), at: Date.parse(at) },
		]);
		for (const m of messages) expect([m.ack.mock.calls.length, m.retry.mock.calls.length]).toEqual([1, 0]);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});
});
