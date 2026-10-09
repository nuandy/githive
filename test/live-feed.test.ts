import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

const { LiveFeed } = await import("../src/live-feed");

// The dashboard's ready-made views, kept in a repo's live feed: a write makes
// them stale, a stale view is still served while one build runs, and a view
// built before a write that landed during its build stays stale.

const feed = () => {
	const sent: string[] = [];
	const socket = { send: (message: string) => sent.push(JSON.parse(message).kind) };
	return { live: new LiveFeed({ storage: new FakeStorage(), getWebSockets: () => [socket] } as never, {} as never), sent };
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
	it("serves a kept tip, with its state when kept for that tip", async () => {
		const { live } = feed();
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ gen: 0 });
		await live.keepTip("refs/r", "a".repeat(40), 0);
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ tip: "a".repeat(40), gen: 0 });
		await live.keepRecord("refs/r@1", "a".repeat(40), "{}");
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ tip: "a".repeat(40), gen: 0, json: "{}" });
		// No ref is kept too: an empty log.
		await live.keepTip("refs/empty", null, 0);
		expect(await live.tipOf("refs/empty", "refs/empty@1", 10_000)).toEqual({ tip: null, gen: 0 });
	});

	it("forgets a tip when its ref moves, and drops a listing that began before", async () => {
		const { live } = feed();
		await live.keepTip("refs/r", "a".repeat(40), 0);
		const { gen } = await live.tipOf("refs/s", "refs/s@1", 10_000);
		await live.movedTip("refs/r");
		await live.movedTip("refs/s");
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toEqual({ gen: 1 });
		// Listed before the move: it may show the old tip, so it isn't kept.
		await live.keepTip("refs/s", "b".repeat(40), gen);
		expect(await live.tipOf("refs/s", "refs/s@1", 10_000)).toEqual({ gen: 1 });
	});

	it("ages a tip out", async () => {
		const { live } = feed();
		await live.keepTip("refs/r", "a".repeat(40), 0);
		expect(await live.tipOf("refs/r", "refs/r@1", -1)).toEqual({ gen: 0 });
	});
});
