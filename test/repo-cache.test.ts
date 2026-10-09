import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");

// The dashboard's ready-made views, kept in a repo's cache: a write makes
// them stale, a stale view is still served while one build runs, and a view
// built before a write that landed during its build stays stale.

const feed = () => {
	const sent: string[] = [];
	const socket = { send: (message: string) => sent.push(JSON.parse(message).kind) };
	return { live: new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [socket] } as never, {} as never), sent };
};

describe("kept views", () => {
	it("has nothing until a view is built, then serves it fresh", async () => {
		const { live, sent } = feed();
		expect(await live.view("snapshot", 60_000)).toEqual({ json: undefined, fresh: false, building: false, writes: 0 });
		expect(await live.startBuild("snapshot")).toBe(true);
		await live.keep("snapshot", '{"open":1}', 0);
		expect(await live.view("snapshot", 60_000)).toMatchObject({ json: '{"open":1}', fresh: true, building: false });
		expect(sent).toEqual(["view:snapshot"]);
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

describe("forgetting a deleted repo's views", () => {
	it("drops everything kept for it, however much, the heads seen on its changes among it", async () => {
		const { live } = feed();
		await live.noteHeads(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`note-${i}`, `h${i}`])));
		await live.landingSettled("master", [{ change: "note-1", head: "h1", agent: "a", how: "landed", at: new Date().toISOString(), commit: "m1" }]);
		expect(Object.keys(await live.knownHeads(Array.from({ length: 300 }, (_, i) => `note-${i}`)))).toHaveLength(300);
		await live.clearViews();
		expect(await live.knownHeads(["note-1", "note-299"])).toEqual({});
		expect((await live.landingView("master")).recent).toEqual([]);
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


describe("kept record tips", () => {
	const a = "a".repeat(40);
	const b = "b".repeat(40);
	const c = "c".repeat(40);

	it("sends one caller to list a ref nothing is kept for, and the others to wait for it", async () => {
		const { live } = feed();
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ gen: 0 });
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ gen: 0, wait: true });
		await live.keepTip("refs/r", a, 0);
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ tip: a, gen: 0 });
		await live.keepRecord("refs/r@1", a, "{}");
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ tip: a, gen: 0, json: "{}" });
		// No ref is kept too: an empty log.
		await live.tipOf("refs/empty", "refs/empty@1", 10_000);
		await live.keepTip("refs/empty", null, 0);
		expect(await live.tipOf("refs/empty", "refs/empty@1", 10_000)).toEqual({ tip: null, gen: 0 });
	});

	it("keeps a write's tip when it built on the one kept, and forgets it when writes arrive out of order", async () => {
		const { live } = feed();
		await live.keepTip("refs/r", a, 0);
		await live.landedTip("refs/r", a, b);
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toMatchObject({ tip: b });
		// c built on something other than b: b's write arrived late, or one was lost.
		await live.landedTip("refs/r", a, c);
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ gen: 2 });
	});

	it("drops a listing that began before a write, and a tip a write found out of date", async () => {
		const { live } = feed();
		await live.tipOf("refs/s", "refs/s@1", 10_000);
		await live.keepTip("refs/s", null, 0);
		// A listing begins; a write lands meanwhile (on the empty ref kept, so its tip is kept).
		await live.tipOf("refs/s", "refs/s@1", -1);
		await live.landedTip("refs/s", null, a);
		// Listed before the write: it may show no ref at all, so it isn't kept.
		await live.keepTip("refs/s", null, 0);
		expect(await live.tipOf("refs/s", "refs/s@1", 10_000)).toMatchObject({ tip: a });
		await live.staleTip("refs/s", b);
		expect(await live.tipOf("refs/s", "refs/s@1", 10_000)).toMatchObject({ tip: a });
		await live.staleTip("refs/s", a);
		expect(await live.tipOf("refs/s", "refs/s@1", 10_000)).toEqual({ gen: 2 });
		// Nothing kept: a write can't tell it's the latest, so its tip waits for a listing.
		await live.landedTip("refs/t", null, a);
		expect(await live.tipOf("refs/t", "refs/t@1", 10_000)).toEqual({ gen: 1 });
	});

	it("serves an aged tip to all but one caller, who refreshes it", async () => {
		const { live } = feed();
		await live.keepTip("refs/r", a, 0);
		expect(await live.tipOf("refs/r", "refs/r@1", -1)).toEqual({ gen: 0 });
		expect(await live.tipOf("refs/r", "refs/r@1", -1)).toEqual({ tip: a, gen: 0 });
	});
});
