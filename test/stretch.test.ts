import { describe, expect, it } from "vitest";
import type { Settled } from "../src/toolkit/landing";
import { STRETCH_GAP_MS, extendStretch, stretchSummary } from "../src/toolkit/stretch";

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

	it("takes a batch's outcomes in time order, whatever order they come in", () => {
		const stretch = extendStretch(undefined, [outcome("bob", 5), outcome("ann", 2)]);
		expect(stretch).toMatchObject({ from: at(2), to: at(5), agents: ["ann", "bob"] });
	});
});
