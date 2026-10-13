import { describe, expect, it } from "vitest";
import { briefPaths, shortTitle } from "./model";

describe("briefPaths", () => {
	it("lists a few paths, then how many more", () => {
		expect(briefPaths(["a", "b"])).toBe("a, b");
		expect(briefPaths(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
		expect(briefPaths([])).toBe("");
	});
});

describe("shortTitle", () => {
	it("cuts a long title at a word, and leaves a short one", () => {
		expect(shortTitle("Let shoppers apply a coupon code in the cart drawer.", 30)).toBe("Let shoppers apply a coupon…");
		expect(shortTitle("Fix: the cart badge kept the old count", 12)).toBe("Fix: the…");
		expect(shortTitle("Short.", 30)).toBe("Short.");
		expect(shortTitle("Averyveryverylongwordwithoutspaces", 10)).toBe("Averyveryv…");
	});
});
