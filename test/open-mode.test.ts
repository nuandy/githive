import { describe, expect, it } from "vitest";
import { changeId, entriesOverlap, inLaneEntry, leaseExpired, normalizeClaim, openTaskId } from "../src/open-mode";
import { slice, task } from "./fakes/env";

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
		for (const bad of [[], ["/etc"], ["src/../x"], ["src//x"], [""], [3]]) expect(() => normalizeClaim(bad)).toThrow(/\[400\]/);
	});

	it("makes slug ids that fit repo names", () => {
		const id = changeId("Add rate limiting to the API!");
		expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(id.startsWith("add-rate-limiting-to-the")).toBe(true);
		expect(changeId("!!!")).toMatch(/^change-[0-9a-f]{4}$/);
	});

	it("gives a repo the same open task id every time", async () => {
		const id = await openTaskId("blueprint");
		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(await openTaskId("blueprint")).toBe(id);
		expect(await openTaskId("other")).not.toBe(id);
	});
});

describe("leases", () => {
	const past = new Date(Date.now() - 1_000).toISOString();
	it("expire only for changes waiting on their own agent", () => {
		const t = task({ mode: "open" });
		expect(leaseExpired(t, slice("a", { leaseUntil: past }))).toBe(true);
		expect(leaseExpired(t, slice("a", { leaseUntil: new Date(Date.now() + 60_000).toISOString() }))).toBe(false);
		expect(leaseExpired(t, slice("a", { leaseUntil: past, reviewHead: "h1" }))).toBe(false);
		expect(leaseExpired(t, slice("a", { leaseUntil: past, reviewHead: "h1", sentBackFor: "h1" }))).toBe(true);
		expect(leaseExpired(t, slice("a", { leaseUntil: past, gate: { status: "queued", head: "h", baseHead: "", at: "", excluded: [] } }))).toBe(false);
		const waiting = task({ mode: "open", laneChangeRequests: [{ id: "r", requester: "a", owner: "b", path: "p", need: "n", reason: "r", status: "pending", createdAt: "" }] } as never);
		expect(leaseExpired(waiting, slice("a", { leaseUntil: past }))).toBe(false);
	});
});

describe("the refusal an agent sees for an overlapping claim", () => {
	it("names each holder once, with what overlaps under it, and shortens a long list", async () => {
		const { conflictMessage } = await import("../src/open-mode");
		const many = Array.from({ length: 12 }, (_, i) => ({ path: "examples/", holder: "modernize-1", held: `examples/e${i}.js`, title: "Modernize", intent: "Use const" }));
		const message = conflictMessage([...many, { path: "lib/a.js", holder: "lib-1", held: "lib/a.js", title: "Lib", intent: "Tidy lib" }]);
		expect(message.match(/held by change modernize-1/g)).toHaveLength(1);
		expect(message).toContain('- held by change modernize-1 ("Modernize"): Use const\n  examples/ overlaps examples/e0.js;');
		expect(message).toContain("examples/ overlaps examples/e9.js, and 2 more");
		expect(message).toContain('- held by change lib-1 ("Lib"): Tidy lib\n  lib/a.js\n');
	});
});
