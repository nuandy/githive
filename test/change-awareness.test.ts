import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Footprint } from "../src/footprint-cache";
import { changeHistory, repoSnapshot, type ToolContext } from "../src/toolkit/mcp";
import { challenge, CHALLENGE_WINDOW_MS, type Challenges, challengesRef } from "../src/toolkit/challenges";
import { recordLog } from "../src/toolkit/tools/repo";
import { FakeStorage } from "./fakes/env";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

const { RepoCache } = await import("../src/repo-cache");
const { FootprintCache } = await import("../src/footprint-cache");

// What the dashboard shows of what agents hear about a change: where its footprint meets other open changes (from the
// FootprintCache), its last merge check's conflict and its earlier attempts (from the RepoCache), through the change
// view; and each claim's lease, through the repo's snapshot.

function caches() {
	const repoCache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
	const footprints = new FootprintCache(
		{ storage: new FakeStorage() } as never,
		{ REPO_CACHE: { getByName: () => repoCache } } as never,
	);
	return { repoCache, footprints };
}

const BEFORE = "export function loadSettings(path: string): Settings";
const AFTER = "export function loadSettings(path: string): Result<Settings>";
const loadSettings = { name: "loadSettings", change: "interface" as const, before: BEFORE, after: AFTER };
const storeGet = { name: "Store.get", change: "removed" as const, before: "get(key: string): string" };
const formatDate = { name: "formatDate", change: "removed" as const, before: "export function formatDate(d: Date)" };

const footprint = (change: string, agent: string, more: Partial<Footprint> = {}): Footprint => ({
	change,
	agent,
	intent: `${change}'s intent`,
	branch: "main",
	head: `h-${change}`,
	base: "b0",
	at: 1,
	alters: [],
	uses: [],
	...more,
});
const uses = (file: string, name: string, at: string, line: number) => ({ file, name, at: [{ file: at, line }] });
const claimedBy = (...footprints: Footprint[]) =>
	Object.fromEntries(footprints.map((each) => [each.change, each.agent]));

describe("a change's footprint and where it meets other open changes", () => {
	it("says what it alters that others use, and what it uses that others alter, by whom and where", async () => {
		const { footprints } = caches();
		const alice = footprint("c-7", "alice", {
			alters: [
				{ file: "src/config.ts", altered: loadSettings },
				{ file: "src/config.ts", altered: storeGet },
			],
			uses: [uses("src/dates.ts", "formatDate", "src/config.ts", 2)],
		});
		const carol = footprint("c-3", "carol", { uses: [uses("src/config.ts", "loadSettings", "src/jobs/sync.ts", 4)] });
		const dave = footprint("c-5", "dave", { uses: [uses("src/config.ts", "Store", "src/cache.ts", 9)] });
		const bob = footprint("c-9", "bob", { alters: [{ file: "src/dates.ts", altered: formatDate }] });
		// Nothing is said between an agent's own changes, nor across branches.
		const mine = footprint("c-8", "alice", { uses: [uses("src/config.ts", "loadSettings", "src/mine.ts", 1)] });
		const elsewhere = footprint("c-4", "erin", {
			branch: "feature",
			uses: [uses("src/config.ts", "loadSettings", "src/feature.ts", 1)],
		});
		const all = [carol, dave, bob, mine, elsewhere, alice];
		for (const each of all) await footprints.keep("p", each, claimedBy(...all));

		expect(await footprints.overlapsOf("c-7")).toEqual({
			change: "c-7",
			agent: "alice",
			branch: "main",
			head: "h-c-7",
			base: "b0",
			at: 1,
			alters: [
				{ file: "src/config.ts", altered: loadSettings },
				{ file: "src/config.ts", altered: storeGet },
			],
			uses: [uses("src/dates.ts", "formatDate", "src/config.ts", 2)],
			usedBy: [
				{
					file: "src/config.ts",
					altered: loadSettings,
					imported: "loadSettings",
					at: [{ file: "src/jobs/sync.ts", line: 4 }],
					other: { by: "carol", change: "c-3", intent: "c-3's intent" },
				},
				// A class's member, through its class.
				{
					file: "src/config.ts",
					altered: storeGet,
					imported: "Store",
					at: [{ file: "src/cache.ts", line: 9 }],
					other: { by: "dave", change: "c-5", intent: "c-5's intent" },
				},
			],
			alteredBy: [
				{
					file: "src/dates.ts",
					altered: formatDate,
					imported: "formatDate",
					at: [{ file: "src/config.ts", line: 2 }],
					other: { by: "bob", change: "c-9", intent: "c-9's intent" },
				},
			],
		});
		// The other side sees the same overlap the other way round.
		expect((await footprints.overlapsOf("c-3"))?.alteredBy).toEqual([
			{
				file: "src/config.ts",
				altered: loadSettings,
				imported: "loadSettings",
				at: [{ file: "src/jobs/sync.ts", line: 4 }],
				other: { by: "alice", change: "c-7", intent: "c-7's intent" },
			},
		]);
		expect(await footprints.overlapsOf("c-1")).toBeNull();
	});

	it("meets a whole-file use through every name altered in the file, and forgets a change once it's dropped", async () => {
		const { footprints } = caches();
		const alice = footprint("c-7", "alice", {
			alters: [
				{ file: "src/config.ts", altered: loadSettings },
				{ file: "src/config.ts", altered: storeGet },
			],
		});
		const whole = footprint("c-1", "bob", { uses: [uses("src/config.ts", "*", "src/all.ts", 1)] });
		const both = claimedBy(alice, whole);
		await footprints.keep("p", alice, both);
		await footprints.keep("p", whole, both);
		const seen = await footprints.overlapsOf("c-1");
		// In the order of the names as importers know them: Store, then loadSettings.
		expect(seen?.alteredBy.map((overlap) => [overlap.altered.name, overlap.imported, overlap.other.change])).toEqual([
			["Store.get", "*", "c-7"],
			["loadSettings", "*", "c-7"],
		]);
		expect((await footprints.overlapsOf("c-7"))?.usedBy.map((overlap) => overlap.imported)).toEqual(["*", "*"]);
		await footprints.drop(["c-7"]);
		expect((await footprints.overlapsOf("c-1"))?.alteredBy).toEqual([]);
	});

	it("returns at most 50 overlaps each way, saying how many it left out", async () => {
		const { footprints } = caches();
		const names = ["a", "b", "c"].map((name) => ({ name, change: "interface" as const, before: "x", after: "y" }));
		const alice = footprint("x-1", "alice", {
			alters: names.map((altered) => ({ file: "src/lib.ts", altered })),
		});
		// 20 changes use each of three names: 60 overlaps.
		const users = names.flatMap(({ name }) =>
			Array.from({ length: 20 }, (_, i) =>
				footprint(`${name}-${i}`, `agent-${name}-${i}`, { uses: [uses("src/lib.ts", name, `src/${name}${i}.ts`, 1)] }),
			),
		);
		const claimed = claimedBy(alice, ...users);
		for (const user of users) await footprints.keep("p", user, claimed);
		// Its heads-ups go past their own cap, which logs.
		const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await footprints.keep("p", alice, claimed);
		logs.mockRestore();
		const seen = await footprints.overlapsOf("x-1");
		expect(seen?.usedBy).toHaveLength(50);
		expect(seen?.omitted).toEqual({ usedBy: 10 });
	});
});

describe("a change's page", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-change-awareness-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	const { repoCache, footprints } = caches();
	const kept = new Map<string, { key: string; result: unknown }>();
	const hooks: Partial<ToolContext> = {
		mergeChecks: {
			kept: async (_repo, change) => kept.get(change) ?? null,
			keep: async (_repo, change, entry) => void kept.set(change, entry),
		},
		attemptsOf: async (_repo, changes) => repoCache.attemptsOf(changes),
		awarenessOf: async (_repo, change) => footprints.overlapsOf(change),
	};
	const { ctx, call, register } = toolCalls(() => server, hooks);

	/** A commit on main by a landed change a-1, then b-1 started before it, both changing shared.txt. */
	async function conflicting() {
		const base = server.git("rev-parse", "main").trim();
		const seed = await agentClone(server.url, work, "seed");
		seed.write("shared.txt", "a\n");
		await seed.run("add", "shared.txt");
		const trailers = "GitHive-Change: a-1\nGitHive-Intent: add shared\nGitHive-Agent: a";
		await seed.run("commit", "-q", "-m", "add shared", "-m", trailers);
		await seed.run("push", "--quiet", "origin", "main");
		const main = server.git("rev-parse", "main").trim();
		const head = await pushChange(server.url, work, "b", "b-1", { "shared.txt": "b\n" }, base);
		return { main, head };
	}

	it("carries the last merge check's conflict, the earlier attempts, and where its footprint meets others", async () => {
		await call("settings", { required: 1, vetoes: [] });
		await register("b");
		await call("claim", { change: "b-1", agent: "b", paths: ["shared.txt"], intent: "share b" }, "b");
		const { main, head } = await conflicting();
		// status works the merge check out and keeps it, as it does for the agent.
		expect(await call("status", { change: "b-1" }, "b")).toMatchObject({ merge: { clean: false } });
		await repoCache.noteAttempt("b-1", `conflict on shared.txt with a-1 by a ("add shared", ${main.slice(0, 7)})`);
		const theirs = footprint("c-3", "carol", { uses: [uses("src/config.ts", "loadSettings", "src/jobs/sync.ts", 4)] });
		const ours = footprint("b-1", "b", { head, alters: [{ file: "src/config.ts", altered: loadSettings }] });
		for (const each of [theirs, ours]) await footprints.keep("p", each, claimedBy(theirs, ours));

		const history = await changeHistory(ctx(), "p", "b-1");
		expect(history.merge).toEqual({
			head,
			into: "main",
			branchHead: main,
			clean: false,
			conflicts: ["shared.txt"],
			causes: [],
			touchedBy: [{ file: "shared.txt", commit: main, change: "a-1", agent: "a", intent: "add shared" }],
			hunks: [{ file: "shared.txt", content: expect.stringContaining("<<<<<<< ours (changes/b-1)"), truncated: false }],
			fix: [
				"git fetch origin main && git merge origin/main",
				"# resolve shared.txt so both changes make sense, then:",
				"git add -u && git commit --no-edit",
				"git push fork changes/b-1",
				"call status; once the new commit is approved, merge again",
			],
			outsideClaim: [],
		});
		expect(history.attempts).toEqual([`conflict on shared.txt with a-1 by a ("add shared", ${main.slice(0, 7)})`]);
		expect(history.awareness).toMatchObject({
			change: "b-1",
			head,
			usedBy: [{ altered: loadSettings, at: [{ file: "src/jobs/sync.ts", line: 4 }], other: { change: "c-3" } }],
			alteredBy: [],
		});

		// Once released, there's no merge check or footprint to read; its attempts are still its own.
		await call("release", { change: "b-1", agent: "b" }, "b");
		const released = await changeHistory(ctx(), "p", "b-1");
		expect(released).not.toHaveProperty("merge");
		expect(released).not.toHaveProperty("awareness");
		expect(released.attempts).toHaveLength(1);
	});

	it("leaves out each hint it can't read, and logs it, but still shows the change", async () => {
		await call("settings", { required: 1, vetoes: [] });
		await register("b");
		await call("claim", { change: "b-1", agent: "b", paths: ["b.txt"], intent: "b" }, "b");
		await pushChange(server.url, work, "b", "b-1", { "b.txt": "b\n" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failing: ToolContext = {
			...ctx(),
			mergeChecks: {
				kept: async () => {
					throw new Error("RepoCache down");
				},
				keep: async () => undefined,
			},
			attemptsOf: () => {
				throw new Error("RepoCache down");
			},
			awarenessOf: async () => {
				throw new Error("no FOOTPRINT_CACHE");
			},
		};
		const history = await changeHistory(failing, "p", "b-1");
		expect(history).toMatchObject({ change: "b-1", commits: [{ message: "b-1: work" }] });
		for (const field of ["merge", "attempts", "awareness"]) expect(history).not.toHaveProperty(field);
		const logged = errors.mock.calls.map(([line]) => String(line));
		expect(logged).toEqual(
			expect.arrayContaining([
				"reading b-1's merge check on p for the dashboard failed",
				"reading b-1's attempts on p for the dashboard failed",
				"reading b-1's footprint on p for the dashboard failed",
			]),
		);
		errors.mockRestore();
	});
});

describe("the dashboard's claims", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-claim-lease-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});
	let checking: { change: string; head: string; agent: string }[] = [];
	const { ctx, call, register } = toolCalls(() => server, {
		landing: () =>
			({
				view: async () => ({
					checking: checking.length ? { base: "x", since: "y", changes: checking } : null,
					recent: [],
				}),
			}) as never,
	});
	const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

	it("say when each frees up if its agent goes quiet, or whose turn it waits on", async () => {
		checking = [];
		await call("settings", { required: 1, vetoes: [] });
		await register("a", "b");
		await call("claim", { change: "a-1", agent: "a", paths: ["a.txt"], intent: "a" }, "a");
		await call("claim", { change: "b-1", agent: "b", paths: ["b.txt"], intent: "b" }, "b");
		const head = await pushChange(server.url, work, "b", "b-1", { "b.txt": "b\n" });
		const leases = async () =>
			Object.fromEntries(
				(await repoSnapshot(ctx(), "p")).claims.map((claim) => [claim.change, [claim.active, claim.lease]]),
			);
		const first = await leases();
		// Nothing pushed, and nobody has asked whether its agent is still there: it lasts. Pushed: it waits on review.
		expect(first["a-1"]![1]).toEqual({ waitingOn: "agent" });
		expect(first["b-1"]![1]).toEqual({ waitingOn: "reviewers" });
		// Asked, it frees up once its agent's time to answer is up.
		const held = { change: "a-1", agent: "a", active: first["a-1"]![0] as string };
		const { challenge: asked } = await challenge(recordLog<Challenges>(ctx(), "p", challengesRef("p")), held, "b");
		const challenged = (await repoSnapshot(ctx(), "p")).claims.find((claim) => claim.change === "a-1")!;
		expect(challenged).toMatchObject({
			challenged: asked.at,
			lease: { waitingOn: "agent", freeAfter: at(asked.at, CHALLENGE_WINDOW_MS) },
		});
		// In the batch being checked, it waits on the landing.
		checking = [{ change: "b-1", head, agent: "b" }];
		expect((await leases())["b-1"]![1]).toEqual({ waitingOn: "landing" });
	});
});
