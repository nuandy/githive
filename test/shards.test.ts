import { describe, expect, it } from "vitest";
import { entriesOverlap } from "../src/claim-paths";
import { ancestorsOf, decodeShard, encodeShard, isWide, shardOf } from "../src/toolkit/shards";

// Claims are split by path into shards, each its own Git ref, so agents working
// in different parts of the tree never write the same ref. A claim lives in the
// shard of its first `depth` path segments; a shallower ("wide") claim lives in
// its own path's shard, an ancestor of the shards it covers.

describe("shards", () => {
	it("puts a path in the shard of its first `depth` segments", () => {
		expect(shardOf("src/stats/index.ts", 2)).toBe("src/stats");
		expect(shardOf("src/stats/", 2)).toBe("src/stats");
		expect(shardOf("src/router.ts", 2)).toBe("src/router.ts");
		expect(shardOf("docs/", 2)).toBe("docs");
		expect(shardOf("README.md", 2)).toBe("README.md");
	});

	it("calls a claim shallower than the depth wide: it covers the shards under it", () => {
		expect(isWide("docs/", 2)).toBe(true);
		expect(isWide("README.md", 2)).toBe(true);
		expect(isWide("src/stats/", 2)).toBe(false);
		expect(isWide("src/stats/index.ts", 2)).toBe(false);
	});

	it("lists a shard's ancestors, nearest last", () => {
		expect(ancestorsOf("src/stats")).toEqual(["src"]);
		expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b"]);
		expect(ancestorsOf("docs")).toEqual([]);
	});

	it("puts any two overlapping claims in the same shard, or in an ancestor and its descendant", () => {
		const entries = [
			"src/",
			"src",
			"src/stats/",
			"src/stats/index.ts",
			"src/stats/deep/x.ts",
			"src/router.ts",
			"docs/",
			"docs/a.md",
			"README.md",
			"a/b/c/d.ts",
			"a/",
		];
		for (const depth of [1, 2, 3])
			for (const a of entries)
				for (const b of entries) {
					if (!entriesOverlap(a, b)) continue;
					const [sa, sb] = [shardOf(a, depth), shardOf(b, depth)];
					const related = sa === sb || ancestorsOf(sa).includes(sb) || ancestorsOf(sb).includes(sa);
					expect(related, `${a} and ${b} at depth ${depth}: ${sa} / ${sb}`).toBe(true);
					// The shallower of two related shards holds a wide claim, which checks the shards under it.
					if (sa !== sb) expect(ancestorsOf(sa).includes(sb) ? isWide(b, depth) : isWide(a, depth)).toBe(true);
				}
	});

	it("encodes a shard as one valid ref component, and back", () => {
		for (const shard of ["src/stats", ".github/workflows", "a.lock", "weird name/ünïcode", "x..y"]) {
			const encoded = encodeShard(shard);
			expect(encoded).toMatch(/^[A-Za-z0-9_%-]+$/);
			expect(decodeShard(encoded)).toBe(shard);
		}
		// Descendants share the encoded prefix plus the separator.
		expect(encodeShard("src/stats").startsWith(`${encodeShard("src")}%2F`)).toBe(true);
	});
});
