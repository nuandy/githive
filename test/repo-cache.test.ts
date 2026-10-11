import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");

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
