import { describe, expect, it } from "vitest";
import { briefPaths } from "./model";

describe("briefPaths", () => {
	it("lists a few paths, then how many more", () => {
		expect(briefPaths(["a", "b"])).toBe("a, b");
		expect(briefPaths(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
		expect(briefPaths([])).toBe("");
	});
});
