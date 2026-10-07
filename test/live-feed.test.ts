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

describe("review holds", () => {
	it("holds a review for as many agents as it needs, atomically, until they vote or the hold runs out", async () => {
		const { live } = feed();
		expect(await live.holdReview("h1", "agent-a", 1)).toBe(true);
		// Needed once and held: the next agent is turned away; the holder may take it again.
		expect(await live.holdReview("h1", "agent-b", 1)).toBe(false);
		expect(await live.holdReview("h1", "agent-a", 1)).toBe(true);
		// Needed twice: room for a second.
		expect(await live.holdReview("h1", "agent-b", 2)).toBe(true);
		expect(await live.reviewsHeld()).toEqual({ h1: ["agent-a", "agent-b"] });
		// Voted: held a minute more, until the vote shows everywhere, then gone.
		const now = Date.now();
		await live.releaseReview("h1", "agent-a");
		expect(await live.reviewsHeld()).toEqual({ h1: ["agent-a", "agent-b"] });
		const later = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
		try {
			expect(await live.reviewsHeld()).toEqual({ h1: ["agent-b"] });
		} finally {
			later.mockRestore();
		}
	});

	it("lets holds run out", async () => {
		const { live } = feed();
		const now = Date.now();
		await live.holdReview("h1", "agent-a", 1);
		const later = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
		try {
			expect(await live.reviewsHeld()).toEqual({});
			expect(await live.holdReview("h1", "agent-b", 1)).toBe(true);
		} finally {
			later.mockRestore();
		}
	});
});
