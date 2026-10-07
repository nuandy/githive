import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/toolkit/records";
import { MemoryLog } from "./helpers/memory-log";

// Every claim, release and refresh appends to one ref, so under load an append
// keeps losing compare-and-swap to others. It must keep trying, spaced out with
// random backoff so the losers don't all collide again, well past a burst.

const empty = () => ({ n: 0 });
const bump = (state: { n: number }) => ({ state: { n: state.n + 1 }, text: "bump" });

describe("appendRecord under contention", () => {
	it("keeps trying through a burst of competing appends, and lands on the latest state", async () => {
		const log = new MemoryLog<{ n: number }>();
		// Another author lands first, eight times in a row.
		let competitors = 8;
		const compete = async () => {
			if (competitors-- <= 0) return;
			await appendRecord(log, "other", empty, bump);
			log.beforeAppend = compete;
		};
		log.beforeAppend = compete;
		const started = Date.now();
		expect(await appendRecord(log, "me", empty, bump)).toMatchObject({ ok: true });
		expect((await log.read())!.commit.state.n).toBe(9);
		// It backed off between attempts rather than spinning.
		expect(Date.now() - started).toBeGreaterThan(20);
	}, 20_000);

	it("says the Git server is busy when that, not another writer, kept the append out", async () => {
		const busy = { read: async () => null, append: async () => null, lastRefusal: "busy" as const };
		await expect(appendRecord(busy, "me", empty, bump)).rejects.toThrow("[503] the Git server stayed busy; try again");
	}, 30_000);
});
