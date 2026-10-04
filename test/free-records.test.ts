import { describe, expect, it } from "vitest";
import { appendRecord } from "../src/free/records";
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
			await appendRecord(new MemoryLogView(log), "other", empty, bump);
			log.beforeAppend = compete;
		};
		log.beforeAppend = compete;
		const started = Date.now();
		expect(await appendRecord(log, "me", empty, bump)).toMatchObject({ ok: true });
		expect((await log.read())!.commit.state.n).toBe(9);
		// It backed off between attempts rather than spinning.
		expect(Date.now() - started).toBeGreaterThan(20);
	}, 20_000);

	it("commits appends that arrive together as one push, each checked against the ones before it", async () => {
		const log = new MemoryLog<{ n: number; who: string[] }>();
		const start = () => ({ n: 0, who: [] as string[] });
		const add = (who: string) => (state: { n: number; who: string[] }) => ({ state: { n: state.n + 1, who: [...state.who, who] }, text: `${who} adds` });
		const outcomes = await Promise.all(["a", "b", "c", "d", "e"].map((who) => appendRecord(log, who, start, add(who))));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		expect((await log.read())!.commit.state.n).toBe(5);
		// The first goes alone; the rest, arriving meanwhile, go in one push.
		expect(log.commits.length).toBeLessThanOrEqual(2);
		expect(log.commits.at(-1)!.commit.entries.length).toBeGreaterThan(1);
	});

	it("refuses an append its batch has made impossible, and lands the rest", async () => {
		const log = new MemoryLog<{ holder: string | null }>();
		const take = (who: string) => (state: { holder: string | null }) => (state.holder ? { refused: `held by ${state.holder}` } : { state: { holder: who }, text: `${who} takes it` });
		const outcomes = await Promise.all(["a", "b", "c"].map((who) => appendRecord(log, who, () => ({ holder: null }), take(who))));
		expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
		expect(outcomes.filter((o) => !o.ok).map((o) => (o as { refused: string }).refused)).toEqual(["held by a", "held by a"]);
	});

	it("re-checks a whole batch on the new state when another writer gets there first", async () => {
		const log = new MemoryLog<{ n: number }>();
		log.beforeAppend = async () => void (await appendRecord(new MemoryLogView(log), "elsewhere", empty, bump));
		const outcomes = await Promise.all([1, 2, 3].map(() => appendRecord(log, "me", empty, bump)));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		expect((await log.read())!.commit.state.n).toBe(4);
	});
});

/** Another isolate's view of the same ref: its own object, so its appends aren't batched with this one's. */
class MemoryLogView<S> {
	constructor(private readonly log: MemoryLog<S>) {}
	read() {
		return this.log.read();
	}
	append(parent: string | null, commit: Parameters<MemoryLog<S>["append"]>[1]) {
		return this.log.append(parent, commit);
	}
}
