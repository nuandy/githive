import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RecordCache } = await import("../src/record-cache");

// Where a record log's ref points and its state there, kept for every Worker instance in an object of the log's
// own: one reader lists the ref while the others wait, a write moves the tip, and a write that arrived out of order
// or a listing older than a write is never kept.

const feed = () => {
	const storage = new FakeStorage();
	return { live: new RecordCache({ storage } as never, {} as never), storage };
};

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
		// A missing ref is cached too, as an empty log.
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

describe("kept record states", () => {
	const a = "a".repeat(40);

	it("leaves out a state the caller already has", async () => {
		const { live } = feed();
		await live.tipOf("refs/r", "refs/r@1", 10_000);
		await live.keepTip("refs/r", a, 0);
		await live.keepRecord("refs/r@1", a, '{"state":1}');
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000)).toMatchObject({ json: '{"state":1}' });
		expect(await live.tipOf("refs/r", "refs/r@1", 10_000, a)).toEqual({ tip: a, gen: 0 });
	});

	it("forgets everything a while after the last write, as for a deleted repo", async () => {
		const { live, storage } = feed();
		await live.keepRecord("refs/r@1", a, "{}");
		expect(storage.alarm).toBeGreaterThan(Date.now() + 24 * 60 * 60_000);
		await live.alarm();
		expect(await live.recordAt("refs/r@1", a)).toBeUndefined();
	});
});
