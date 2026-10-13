import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoCache, RINGS_KEPT } = await import("../src/repo-cache");
const { TOLD_KEPT } = await import("../src/news-log");
const { toolContextFor } = await import("../src/toolkit/env");
type Notice = import("../src/repo-cache").Notice;

// The dashboard's ready-made views, kept in a repo's cache: a write makes
// them stale, a stale view is still served while one build runs, and a view
// built before a write that landed during its build stays stale.

const feed = () => {
	const sent: string[] = [];
	const socket = { send: (message: string) => sent.push(JSON.parse(message).kind) };
	return {
		live: new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [socket] } as never, {} as never),
		sent,
	};
};

describe("kept views", () => {
	it("has nothing until a view is built, then serves it fresh", async () => {
		const { live, sent } = feed();
		expect(await live.view("snapshot", 60_000)).toEqual({ json: undefined, fresh: false, building: false, writes: 0 });
		expect(await live.startBuild("snapshot")).toBe(true);
		const version = await live.keep("snapshot", '{"open":1}', 0);
		expect(await live.view("snapshot", 60_000)).toMatchObject({ json: '{"open":1}', version, fresh: true });
		expect(sent).toEqual(["view:snapshot"]);
	});

	it("leaves out a view the caller already has", async () => {
		const { live } = feed();
		const version = await live.keep("snapshot", '{"open":1}', 0);
		expect(await live.view("snapshot", 60_000, version)).toEqual({
			json: undefined,
			version,
			fresh: true,
			building: false,
			writes: 0,
		});
		expect(await live.view("snapshot", 60_000, version - 1)).toMatchObject({ json: '{"open":1}' });
	});

	it("goes stale on a write but not on a view's own ping", async () => {
		const { live } = feed();
		await live.keep("snapshot", "{}", 0);
		await live.ping("records", false);
		expect(await live.view("snapshot", 60_000)).toMatchObject({ fresh: true });
		await live.ping("records");
		expect(await live.view("snapshot", 60_000)).toMatchObject({ json: "{}", fresh: false, writes: 1 });
	});

	it("lets one build run at a time, and the next once it's kept or failed", async () => {
		const { live } = feed();
		expect(await live.startBuild("audit")).toBe(true);
		expect(await live.startBuild("audit")).toBe(false);
		expect(await live.view("audit", 60_000)).toMatchObject({ building: true });
		await live.buildFailed("audit");
		expect(await live.startBuild("audit")).toBe(true);
		await live.keep("audit", "{}", 0);
		expect(await live.view("audit", 60_000)).toMatchObject({ building: false });
	});

	it("keeps a view built across a write stale, so the next read rebuilds it", async () => {
		const { live } = feed();
		const { writes } = await live.view("snapshot", 60_000);
		await live.ping("records");
		await live.keep("snapshot", "{}", writes);
		expect(await live.view("snapshot", 60_000)).toMatchObject({ fresh: false });
	});

	it("ages a view out", async () => {
		const { live } = feed();
		await live.keep("snapshot", "{}", 0);
		expect(await live.view("snapshot", -1)).toMatchObject({ fresh: false });
	});
});

/** A time `seconds` from now, so it's after any cursor a test's first call started. */
const soon = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const settled = (change: string, agent: string, how: "landed" | "failed", at: string) => ({
	change,
	head: `h-${change}`,
	agent,
	how,
	at,
	...(how === "landed" ? { commit: `c-${change}`, files: [`src/${change}.ts`] } : { reasons: ["checks failed"] }),
});

describe("news of what landed", () => {
	it("tells an agent what others landed since it last heard, nothing old on its first call, never its own", async () => {
		const { live } = feed();
		const landed = (change: string, agent: string, at: string) => ({
			change,
			head: `h-${change}`,
			agent,
			how: "landed" as const,
			at,
			commit: `c-${change}`,
			files: [`src/${change}.ts`],
			intent: `do ${change}`,
		});
		await live.landingSettled("main", [landed("old", "agent-b", "2026-10-10T10:00:00.000Z")]);
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
		await live.landingSettled("main", [
			landed("mine", "agent-a", "2026-10-10T10:01:00.000Z"),
			landed("theirs", "agent-b", "2026-10-10T10:01:00.000Z"),
		]);
		expect(await live.newsFor("main", "agent-a")).toEqual([
			{
				kind: "landed",
				change: "theirs",
				agent: "agent-b",
				at: "2026-10-10T10:01:00.000Z",
				commit: "c-theirs",
				files: ["src/theirs.ts"],
				intent: "do theirs",
			},
		]);
		// Told once.
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
	});

	it("tells the first landings on a new repo", async () => {
		const { live } = feed();
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
		await live.landingSettled("main", [settled("first", "agent-b", "landed", soon(1))]);
		expect(await live.newsFor("main", "agent-a")).toMatchObject([{ kind: "landed", change: "first" }]);
	});

	it("the cursor follows the newest outcome, not the last one kept", async () => {
		const { live } = feed();
		await live.newsFor("main", "agent-a");
		await live.landingSettled("main", [settled("landed", "agent-b", "landed", soon(2))]);
		// A failure noted later, with an earlier time.
		await live.landingSettled("main", [settled("failed", "agent-c", "failed", soon(1))]);
		expect(await live.newsFor("main", "agent-a")).toMatchObject([{ change: "landed" }]);
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
	});
});

describe("notices", () => {
	const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
	const notice = (says: string, at = new Date().toISOString()): Notice => ({
		kind: "interface",
		at,
		says,
		next: "read it",
		change: "c-1",
		from: { agent: "agent-b", change: "c-2" },
	});

	it("delivers a notice on the agent's first call, with the branch it's about", async () => {
		const { live } = feed();
		await live.notify("main", [{ agent: "agent-a", notice: notice("hello") }]);
		expect(await live.newsFor("main", "agent-a")).toEqual([{ ...notice("hello", expect.any(String)), branch: "main" }]);
	});

	it("tells a notice once, after what landed, only to its agent, whichever branch it's about", async () => {
		const { live } = feed();
		await live.newsFor("main", "agent-a");
		await live.landingSettled("main", [settled("theirs", "agent-b", "landed", soon(1))]);
		await live.notify("main", [
			{ agent: "agent-a", notice: notice("second", minutesAgo(2)) },
			{ agent: "agent-a", notice: notice("first", minutesAgo(3)) },
			{ agent: "agent-ab", notice: notice("not a's") },
		]);
		// A change into a feature branch: its agent hears of it in a reply about the project's branch.
		await live.notify("feature", [{ agent: "agent-a", notice: notice("on feature", minutesAgo(1)) }]);
		expect(await live.newsFor("main", "agent-a")).toMatchObject([
			{ kind: "landed", change: "theirs" },
			{ kind: "interface", says: "first", branch: "main" },
			{ kind: "interface", says: "second", branch: "main" },
			{ kind: "interface", says: "on feature", branch: "feature" },
		]);
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
		expect(await live.newsFor("feature", "agent-a")).toEqual([]);
		expect(await live.newsFor("main", "agent-ab")).toMatchObject([{ says: "not a's" }]);
	});

	it("tells at most 50 notices at once, the newest, and none older than a day", async () => {
		const { live } = feed();
		await live.notify("main", [{ agent: "agent-a", notice: notice("stale", minutesAgo(25 * 60)) }]);
		const many = (from: number) =>
			Array.from({ length: 30 }, (_, i) => ({
				agent: "agent-a",
				notice: notice(`n${from + i}`, minutesAgo(59 - from - i)),
			}));
		await live.notify("main", many(0));
		await live.notify("feature", many(30));
		const told = await live.newsFor("main", "agent-a");
		expect(told.map((item) => (item as Notice).says)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i + 10}`));
	});

	it("keeps a notice told in a lost wait reply, and tells a cursor older than the log that it missed some", async () => {
		const storage = new FakeStorage();
		const live = new RepoCache({ storage, getWebSockets: () => [] } as never, {} as never);
		await live.newsFor("main", "agent-a");
		const before = await live.rings();
		await live.notify("main", [{ agent: "agent-a", notice: notice("hello") }]);
		const now = await live.rings();
		// A wait reply tells what rang up to its own seen, and leaves the cursor where the call's seen was.
		const told = await live.newsFor("main", "agent-a", { ack: before, through: now });
		expect(told.map((item) => (item as Notice).says)).toEqual(["hello"]);
		// That reply was lost: the next wait brings the older seen again, and is told again.
		const again = await live.newsFor("main", "agent-a", { ack: before, through: now });
		expect(again.map((item) => (item as Notice).says)).toEqual(["hello"]);
		// This time it arrived: the call after brings its seen, and nothing is told twice.
		expect(await live.newsFor("main", "agent-a", { ack: now, through: now })).toEqual([]);
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
		// A cursor the log has trimmed past is told so, beside whatever it still holds.
		for (let ring = 0; ring < TOLD_KEPT + 50; ring++)
			await live.notify("main", [{ agent: "agent-b", notice: notice(`for b ${ring}`) }]);
		// The log stays near its size, trimmed by the oldest.
		expect((await storage.list({ prefix: "told:" })).size).toBeLessThanOrEqual(TOLD_KEPT + 50);
		const late = await live.newsFor("main", "agent-a");
		expect(late).toEqual([expect.objectContaining({ kind: "missed" })]);
		expect(await live.newsFor("main", "agent-a")).toEqual([]);
	});

	it("keeps the hive events that come with them, and tells watching pages", async () => {
		const { live, sent } = feed();
		const at = new Date().toISOString();
		await live.notify(
			"main",
			[{ agent: "agent-a", notice: notice("hello") }],
			[{ kind: "heads_up", agent: "agent-b", change: "c-2", other: "agent-a", detail: "loadSettings", at }],
		);
		expect(await live.events()).toEqual([
			{ kind: "heads_up", agent: "agent-b", change: "c-2", other: "agent-a", detail: "loadSettings", at },
		]);
		expect(sent).toEqual(["awareness"]);
	});
});

describe("forgetting a deleted repo's views", () => {
	it("drops everything kept for it, however much, the heads seen on its changes among it", async () => {
		const { live } = feed();
		await live.noteHeads(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`note-${i}`, `h${i}`])));
		await live.landingSettled("master", [
			{ change: "note-1", head: "h1", agent: "a", how: "landed", at: new Date().toISOString(), commit: "m1" },
		]);
		expect(Object.keys(await live.knownHeads(Array.from({ length: 300 }, (_, i) => `note-${i}`)))).toHaveLength(300);
		await live.clearViews();
		expect(await live.knownHeads(["note-1", "note-299"])).toEqual({});
		expect((await live.landingView("master")).recent).toEqual([]);
	});

	it("names the repo's record caches for the caller to forget", async () => {
		const { live } = feed();
		await live.noteRecordCache("record:p:refs/notes/githive-claims/p");
		await live.noteRecordCache("record:p:refs/notes/githive-claims/p");
		expect(await live.clearViews()).toEqual(["record:p:refs/notes/githive-claims/p"]);
		expect(await live.clearViews()).toEqual([]);
	});

	it("drops kept views and builds, and keeps counting writes", async () => {
		const { live } = feed();
		await live.keep("snapshot", "{}", 0);
		await live.startBuild("audit");
		await live.ping("records");
		await live.clearViews();
		expect(await live.view("snapshot", 60_000)).toEqual({ json: undefined, fresh: false, building: false, writes: 1 });
		expect(await live.startBuild("audit")).toBe(true);
	});
});

describe("the fork queue", () => {
	it("moves a queue kept as one list under keys of its own, in order", async () => {
		const storage = new FakeStorage();
		await storage.put("forks:queue", [
			{ item: "agent:a", tries: 0 },
			{ item: "agent:b", tries: 1 },
		]);
		const live = new RepoCache({ storage, getWebSockets: () => [] } as never, {} as never);
		expect(await live.forkQueue()).toEqual({ seedsReady: 0, seedsQueued: 0, agentsQueued: 2 });
		await live.queueForks("p", ["agent:b", "agent:c", "seed:0"]);
		expect(await live.forkQueue()).toEqual({ seedsReady: 0, seedsQueued: 1, agentsQueued: 3 });
		expect(await storage.get("forks:queue")).toBeUndefined();
		const items = [...(await storage.list<{ item: string }>({ prefix: "forks:job:" })).values()].map((job) => job.item);
		expect(items).toEqual(["agent:a", "agent:b", "agent:c", "seed:0"]);
	});
});

describe("attempts", () => {
	it("keeps each change's 10 newest attempts, 200 characters of each, and leaves out changes with none", async () => {
		const { live } = feed();
		for (let i = 0; i < 12; i++) await live.noteAttempt("c-1", `conflict ${i}`);
		await live.noteAttempt("c-2", "x".repeat(300));
		expect(await live.attemptsOf(["c-1", "c-2", "c-3", "c-1"])).toEqual({
			"c-1": Array.from({ length: 10 }, (_, i) => `conflict ${i + 2}`),
			"c-2": ["x".repeat(200)],
		});
		const many = Array.from({ length: 300 }, (_, i) => `c-${i}`);
		expect(Object.keys(await live.attemptsOf(many))).toEqual(["c-1", "c-2"]);
		await live.clearViews();
		expect(await live.attemptsOf(["c-1"])).toEqual({});
	});

	it("are cleared when a change lands, so a later claim of its name starts with none", async () => {
		const { live } = feed();
		await live.noteAttempt("c-1", "conflict on a.ts");
		await live.noteAttempt("c-2", "checks failed: npm test exited 1");
		await live.landingSettled("main", [
			settled("c-1", "agent-a", "landed", soon(1)),
			settled("c-2", "agent-b", "failed", soon(1)),
		]);
		expect(await live.attemptsOf(["c-1", "c-2"])).toEqual({ "c-2": ["checks failed: npm test exited 1"] });
	});

	it("are forgotten when a claim is released without merging, through the hook the claim store calls", async () => {
		const { live } = feed();
		const ctx = toolContextFor({ REPO_CACHE: { getByName: () => live } } as never, undefined);
		await live.noteAttempt("c-1", "conflict on a.ts");
		await live.noteAttempt("c-2", "conflict on b.ts");
		await ctx.forgetAttempts!("p", "c-1");
		expect(await live.attemptsOf(["c-1", "c-2"])).toEqual({ "c-2": ["conflict on b.ts"] });
		const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
		const unreachable = toolContextFor(
			{ REPO_CACHE: { getByName: () => ({ forgetAttempts: down }) } } as never,
			undefined,
		);
		await expect(unreachable.forgetAttempts!("p", "c-2")).resolves.toBeUndefined();
	});
});

describe("the hooks tools reach it through", () => {
	it("leave notices for the agent's next news, and a RepoCache that doesn't answer never fails the call", async () => {
		const { live } = feed();
		const ctx = toolContextFor({ REPO_CACHE: { getByName: () => live } } as never, undefined);
		const notice = { kind: "interface", at: new Date().toISOString(), says: "hello" };
		await ctx.notify!("p", "main", [{ agent: "agent-a", notice }]);
		expect(await ctx.news!("p", "main", "agent-a")).toEqual([{ ...notice, branch: "main" }]);
		const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
		const unreachable = toolContextFor({ REPO_CACHE: { getByName: () => ({ notify: down }) } } as never, undefined);
		await expect(unreachable.notify!("p", "main", [{ agent: "agent-a", notice }])).resolves.toBeUndefined();
		const missing = toolContextFor({} as never, undefined);
		await expect(missing.notify!("p", "main", [{ agent: "agent-a", notice }])).resolves.toBeUndefined();
	});

	it("note attempts and read them back, and a RepoCache that doesn't answer never fails the call", async () => {
		const { live } = feed();
		const ctx = toolContextFor({ REPO_CACHE: { getByName: () => live } } as never, undefined);
		await ctx.noteAttempt!("p", "c-1", "conflicted on a.ts");
		expect(await ctx.attemptsOf!("p", ["c-1", "c-2"])).toEqual({ "c-1": ["conflicted on a.ts"] });
		const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
		const unreachable = toolContextFor(
			{ REPO_CACHE: { getByName: () => ({ noteAttempt: down, attemptsOf: down }) } } as never,
			undefined,
		);
		await expect(unreachable.noteAttempt!("p", "c-1", "conflicted")).resolves.toBeUndefined();
		await expect(unreachable.attemptsOf!("p", ["c-1"])).resolves.toEqual({});
	});
});

describe("the doorbell's hold", () => {
	it("answers at once once it has rung past the mark, holds until the next ring, and gives up after ms", async () => {
		const { live } = feed();
		expect(await live.rings()).toBe(0);
		expect(await live.ringAfter(0, 50)).toBeNull();
		const held = live.ringAfter(0, 5_000);
		await live.ping("records");
		expect(await held).toEqual({ rings: 1, reasons: ["records"] });
		// A ring before the hold began still counts: the caller read the count before it.
		expect(await live.ringAfter(0, 5_000)).toEqual({ rings: 1, reasons: ["records"] });
		// Reads ring nothing.
		await live.ping("records", false);
		expect(await live.rings()).toBe(1);
	});

	it("wakes a hold only for a ring that concerns its agent, and every hold for one that concerns everyone", async () => {
		const { live } = feed();
		const at = new Date().toISOString();
		const x = live.ringAfter(0, 5_000, "x");
		const y = live.ringAfter(0, 5_000, "y");
		await live.notify("main", [{ agent: "x", notice: { kind: "heads_up", at, says: "for x", change: "c" } }]);
		expect(await x).toEqual({ rings: 1, reasons: ["notice"] });
		await live.ping("records", true, [], "claim", { for: [] });
		await live.ping("records", true, [], "release");
		// y slept through the notice for x and the claim, and woke for the release, which may offer it work.
		expect(await y).toEqual({ rings: 3, reasons: ["release"] });
		// Between two calls: what rang for each since a mark, from the log.
		expect(await live.rungFor("y", 0)).toEqual(["release"]);
		expect(await live.rungFor("x", 0)).toEqual(["notice", "release"]);
		expect(await live.rungFor("x", 3)).toEqual([]);
		// A hold whose mark is already behind a ring for it answers at once; one behind only others' sleeps.
		expect(await live.ringAfter(1, 5_000, "x")).toEqual({ rings: 3, reasons: ["release"] });
		await live.notify("main", [{ agent: "x", notice: { kind: "heads_up", at, says: "for x again", change: "c" } }]);
		expect(await live.ringAfter(3, 50, "y")).toBeNull();
	});

	it("keeps the last rings in its log, and says when a mark is older than that", async () => {
		const { live } = feed();
		for (let ring = 0; ring < RINGS_KEPT + 2; ring++) await live.ping("records", true, [], "claim", { for: [] });
		expect(await live.rungFor("x", 1)).toBeNull();
		expect(await live.rungFor("x", 2)).toEqual([]);
		// A hold with a mark that old can't be checked, so it answers as rung.
		expect(await live.ringAfter(0, 5_000, "x")).toEqual({ rings: RINGS_KEPT + 2, reasons: [] });
	});
});
