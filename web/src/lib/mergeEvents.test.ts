import { describe, expect, it } from "vitest";
import type { HiveEvent } from "../api";
import { mergeEvents } from "./mergeEvents";

// The hive's feed shows what it read and what the live feed brought since, each event once, in order.

const event = (at: string, agent: string): HiveEvent => ({ kind: "claimed", agent, change: `c-${agent}`, at });

describe("the hive's feed with live events", () => {
	it("shows each event once, oldest first, at most 100", () => {
		const read = [event("2026-10-13T10:00:00.000Z", "a"), event("2026-10-13T10:01:00.000Z", "b")];
		const live = [event("2026-10-13T10:01:00.000Z", "b"), event("2026-10-13T10:02:00.000Z", "c")];
		expect(mergeEvents(read, live).map((each) => each.agent)).toEqual(["a", "b", "c"]);
		const many = Array.from({ length: 120 }, (_, i) =>
			event(new Date(Date.UTC(2026, 9, 13, 11, i)).toISOString(), `n${i}`),
		);
		const shown = mergeEvents([], many);
		expect(shown).toHaveLength(100);
		expect(shown[0]!.agent).toBe("n20");
	});
});
