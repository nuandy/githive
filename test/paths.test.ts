import { describe, expect, it } from "vitest";
import { normalizeClaim } from "../src/claim-paths";
import { repoPath } from "../src/sandbox";

// The path rules each caller applies. They differ on purpose; these pin each one down.

describe("claimed paths", () => {
	const valid = (path: string) => {
		try {
			normalizeClaim([path]);
			return true;
		} catch {
			return false;
		}
	};

	it("accepts plain relative paths and directories", () => {
		for (const path of ["a", "a/b.ts", "src/a/", "./src/a", " src/b.ts ", "a:b", "a\\b", ".hidden/x"])
			expect(valid(path)).toBe(true);
	});

	it("refuses absolute, empty, dotted or doubled segments", () => {
		for (const path of [
			"",
			" ",
			"/",
			"/a",
			"a//b",
			"a/./b",
			"a/..",
			"../a",
			"a/../b",
			"a//",
			".",
			"./",
			"a/.",
			"././a",
		])
			expect(valid(path)).toBe(false);
	});

	it("names the path it refused", () => {
		expect(() => normalizeClaim(["a//b"])).toThrow("[400] invalid path: a//b");
		expect(() => normalizeClaim(["x", 1])).toThrow("[400] paths must be strings");
		expect(() => normalizeClaim(Array.from({ length: 51 }, (_, i) => `f${i}`))).toThrow("[400] claim at most 50 paths");
	});
});

describe("agent file paths", () => {
	it("allows any path inside the repository", () => {
		expect(repoPath("./a/b.ts")).toBe("a/b.ts");
		expect(repoPath("a//b")).toBe("a//b");
		expect(repoPath("a/./b")).toBe("a/./b");
		expect(repoPath("a/")).toBe("a/");
	});

	it("refuses paths that leave it", () => {
		for (const path of ["", "./", "/etc/passwd", "../x", "a/../../x", "a/.."])
			expect(() => repoPath(path)).toThrow("path must stay inside the repository");
	});
});
