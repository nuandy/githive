import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");
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
		expect(await live.landingNews("main", "agent-a")).toEqual([]);
		await live.landingSettled("main", [
			landed("mine", "agent-a", "2026-10-10T10:01:00.000Z"),
			landed("theirs", "agent-b", "2026-10-10T10:01:00.000Z"),
		]);
		expect(await live.landingNews("main", "agent-a")).toEqual([
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
		expect(await live.landingNews("main", "agent-a")).toEqual([]);
	});

	it("tells the first landings on a new repo", async () => {
		const { live } = feed();
		expect(await live.landingNews("main", "agent-a")).toEqual([]);
		await live.landingSettled("main", [settled("first", "agent-b", "landed", soon(1))]);
		expect(await live.landingNews("main", "agent-a")).toMatchObject([{ kind: "landed", change: "first" }]);
	});

	it("the cursor follows the newest outcome, not the last one kept", async () => {
		const { live } = feed();
		await live.landingNews("main", "agent-a");
		await live.landingSettled("main", [settled("landed", "agent-b", "landed", soon(2))]);
		// A failure noted later, with an earlier time.
		await live.landingSettled("main", [settled("failed", "agent-c", "failed", soon(1))]);
		expect(await live.landingNews("main", "agent-a")).toMatchObject([{ change: "landed" }]);
		expect(await live.landingNews("main", "agent-a")).toEqual([]);
	});
});

describe("notices", () => {
	const notice = (says: string, at = new Date().toISOString()): Notice => ({
		kind: "note",
		at,
		says,
		next: "read it",
		change: "c-1",
		from: { agent: "agent-b", change: "c-2" },
	});

	it("delivers a notice on the agent's first call", async () => {
		const { live } = feed();
		await live.notify("main", [{ agent: "agent-a", notice: notice("hello") }]);
		expect(await live.landingNews("main", "agent-a")).toEqual([notice("hello", expect.any(String))]);
	});

	it("tells a notice once, after what landed, and only to its agent on its branch", async () => {
		const { live } = feed();
		await live.landingNews("main", "agent-a");
		await live.landingSettled("main", [settled("theirs", "agent-b", "landed", soon(1))]);
		await live.notify("main", [
			{ agent: "agent-a", notice: notice("second", "2026-10-11T10:01:00.000Z") },
			{ agent: "agent-a", notice: notice("first", "2026-10-11T10:00:00.000Z") },
			{ agent: "agent-ab", notice: notice("not a's") },
		]);
		await live.notify("dev", [{ agent: "agent-a", notice: notice("on dev") }]);
		expect(await live.landingNews("main", "agent-a")).toMatchObject([
			{ kind: "landed", change: "theirs" },
			{ kind: "note", says: "first" },
			{ kind: "note", says: "second" },
		]);
		expect(await live.landingNews("main", "agent-a")).toEqual([]);
		expect(await live.landingNews("main", "agent-ab")).toMatchObject([{ says: "not a's" }]);
		expect(await live.landingNews("dev", "agent-a")).toMatchObject([{ says: "on dev" }]);
	});

	it("keeps at most 50 notices per agent, and none older than a day", async () => {
		const storage = new FakeStorage();
		const live = new RepoCache({ storage, getWebSockets: () => [] } as never, {} as never);
		const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		await live.notify("main", [{ agent: "agent-a", notice: notice("stale", minutesAgo(25 * 60)) }]);
		// Dropped as a later notify trims.
		await live.notify("main", [{ agent: "agent-a", notice: notice("fresh", minutesAgo(60)) }]);
		expect([...(await storage.list<Notice>({ prefix: "notice:" })).values()].map((kept) => kept.says)).toEqual([
			"fresh",
		]);
		const many = Array.from({ length: 60 }, (_, i) => ({
			agent: "agent-a",
			notice: notice(`n${i}`, minutesAgo(59 - i)),
		}));
		await live.notify("main", many);
		expect((await storage.list({ prefix: "notice:" })).size).toBe(50);
		// One older than a day that no notify has trimmed yet is dropped when the agent is told.
		storage.data.set("notice:main:agent-a:2026-01-01T00:00:00.000Z:x", notice("expired", "2026-01-01T00:00:00.000Z"));
		const told = await live.landingNews("main", "agent-a");
		expect(told.map((item) => (item as Notice).says)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i + 10}`));
		expect((await storage.list({ prefix: "notice:" })).size).toBe(0);
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

describe("the hooks tools reach it through", () => {
	it("leave notices for the agent's next news, and a RepoCache that doesn't answer never fails the call", async () => {
		const { live } = feed();
		const ctx = toolContextFor({ REPO_CACHE: { getByName: () => live } } as never, undefined);
		const notice = { kind: "note", at: new Date().toISOString(), says: "hello" };
		await ctx.notify!("p", "main", [{ agent: "agent-a", notice }]);
		expect(await ctx.news!("p", "main", "agent-a")).toEqual([notice]);
		const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
		const unreachable = toolContextFor({ REPO_CACHE: { getByName: () => ({ notify: down }) } } as never, undefined);
		await expect(unreachable.notify!("p", "main", [{ agent: "agent-a", notice }])).resolves.toBeUndefined();
		const missing = toolContextFor({} as never, undefined);
		await expect(missing.notify!("p", "main", [{ agent: "agent-a", notice }])).resolves.toBeUndefined();
	});
});
