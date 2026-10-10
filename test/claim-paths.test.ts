import { describe, expect, it } from "vitest";
import { changeId, entriesOverlap, inLaneEntry, normalizeClaim } from "../src/claim-paths";

// Claimed paths: what a claim covers, when two overlap, and the ids changes get.

describe("lane matching by whole path segments", () => {
	it("holds a path and what is under it, but not a sibling sharing a prefix", () => {
		expect(inLaneEntry("src/stats", "src/stats")).toBe(true);
		expect(inLaneEntry("src/stats/a.ts", "src/stats")).toBe(true);
		expect(inLaneEntry("src/stats-extra.ts", "src/stats")).toBe(false);
		expect(inLaneEntry("src/stats/a.ts", "src/stats/")).toBe(true);
		expect(inLaneEntry("src/statsx/a.ts", "src/stats/")).toBe(false);
	});

	it("finds overlap between entries in either direction", () => {
		expect(entriesOverlap("src/", "src/a.ts")).toBe(true);
		expect(entriesOverlap("src/a/b/", "src/a/")).toBe(true);
		expect(entriesOverlap("src/stats", "src/stats/")).toBe(true);
		expect(entriesOverlap("src/stats", "src/stats-extra.ts")).toBe(false);
		expect(entriesOverlap("web/", "src/")).toBe(false);
	});
});

describe("claims", () => {
	it("normalizes paths and refuses unsafe ones", () => {
		expect(normalizeClaim(["./src/a/", "src/a/", " src/b.ts "])).toEqual(["src/a/", "src/b.ts"]);
		for (const bad of [[], ["/etc"], ["src/../x"], ["src//x"], [""], [3]])
			expect(() => normalizeClaim(bad)).toThrow(/\[400\]/);
	});

	it("makes slug ids that fit repo names", () => {
		const id = changeId("Add rate limiting to the API!");
		expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(id.startsWith("add-rate-limiting-to-the")).toBe(true);
		expect(changeId("!!!")).toMatch(/^change-[0-9a-f]{4}$/);
	});
});
