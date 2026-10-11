import { describe, expect, it } from "vitest";
import { SizedCache, describeCaches } from "../src/sized-cache";

// The isolate's caches stay within their size, so a long-lived isolate never runs out of memory through them.

describe("a sized cache", () => {
	it("drops the least recently used entries once it's over its size", () => {
		const cache = new SizedCache<string>("test strings", 10, "bytes");
		cache.set("a", "aaaa", 4);
		cache.set("b", "bbbb", 4);
		expect(cache.get("a")).toBe("aaaa");
		cache.set("c", "cccc", 4);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("aaaa");
		expect(cache.get("c")).toBe("cccc");
	});

	it("keeps nothing bigger than itself, and counts a value set again once", () => {
		const cache = new SizedCache<string>("test values", 3);
		cache.set("big", "x", 4);
		expect(cache.has("big")).toBe(false);
		cache.set("a", "1");
		cache.set("a", "2");
		cache.set("b", "3");
		cache.set("c", "4");
		expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual(["2", "3", "4"]);
	});

	it("says how full it is", () => {
		const cache = new SizedCache<string>("test sizes", 2 * 1024 * 1024, "bytes");
		cache.set("a", "a", 1024 * 1024);
		expect(cache.describe()).toBe("test sizes 1 (1.0 MB)");
		expect(describeCaches()).toContain("test sizes 1 (1.0 MB)");
	});
});
