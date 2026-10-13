import { describe, expect, it } from "vitest";
import type { Settled } from "../src/toolkit/landing";
import { STRETCH_GAP_MS, extendStretch, freshStretch, stretchSummary } from "../src/toolkit/stretch";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");

// A repo's last stretch of work: what landed since it last went quiet, for the dashboard's "all landed".

const start = Date.parse("2026-10-11T12:00:00.000Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const outcome = (agent: string, minutes: number, how: Settled["how"] = "landed"): Settled => ({
	change: `${agent}-${minutes}`,
	head: "a".repeat(40),
	agent,
	how,
	at: at(minutes),
});

describe("the last stretch of work", () => {
	it("counts what landed and was put out, and each agent once, across batches close together", () => {
		const first = extendStretch(undefined, [outcome("ann", 0), outcome("bob", 1, "failed")]);
		const second = extendStretch(first, [outcome("ann", 10), outcome("cy", 12)]);
		expect(second && stretchSummary(second)).toEqual({ landed: 3, failed: 1, agents: 3, from: at(0), to: at(12) });
	});

	it("starts a new stretch after a long enough gap with nothing landing", () => {
		const earlier = extendStretch(undefined, [outcome("ann", 0)]);
		const later = extendStretch(earlier, [outcome("bob", STRETCH_GAP_MS / 60_000 + 1)]);
		expect(later).toMatchObject({ landed: 1, agents: ["bob"], from: at(16) });
	});

	it("begins afresh where work is known to start, leaving out what landed minutes before", async () => {
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		// The last run's landings, then this run's agents start at minute 4 and their first piece lands at 6.
		await cache.landingSettled("main", [outcome("ann", 0), outcome("bob", 3)]);
		await cache.startStretch(at(4));
		expect(await cache.landingView("main")).not.toHaveProperty("stretch");
		await cache.landingSettled("main", [outcome("cy", 6)]);
		expect((await cache.landingView("main")).stretch).toEqual({
			landed: 1,
			failed: 0,
			agents: 1,
			from: at(4),
			to: at(6),
		});
		expect(extendStretch(freshStretch(at(4)), [outcome("cy", 6)])).toMatchObject({ from: at(4), landed: 1 });
	});

	it("takes a batch's outcomes in time order, whatever order they come in", () => {
		const stretch = extendStretch(undefined, [outcome("bob", 5), outcome("ann", 2)]);
		expect(stretch).toMatchObject({ from: at(2), to: at(5), agents: ["ann", "bob"] });
	});

	it("is worked out from a repo's kept outcomes when they settled before stretches were kept, once", async () => {
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		await (cache as unknown as { keepLanding(branch: string, state: unknown): Promise<void> }).keepLanding("main", {
			checking: null,
			recent: [outcome("ann", 0), outcome("bob", 3)],
		});
		expect(await cache.landingView("main")).toMatchObject({
			stretch: { landed: 2, agents: 2, from: at(0), to: at(3) },
			firstStretch: true,
		});
		expect(await cache.landingView("main")).not.toHaveProperty("firstStretch");
	});
});
