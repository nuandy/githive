import { Language } from "web-tree-sitter";
import { describe, expect, it, vi } from "vitest";
import { fileFacts, newParseBatch } from "../src/footprint";

// A grammar that fails to load costs a batch one try, not one a file: every file of that language in the batch is
// skipped at once, and the next batch tries again. In a file of its own, so the grammar isn't loaded already.

describe("a grammar that fails to load", () => {
	it("is tried once a batch, its files skipped, and loads again in a later batch", async () => {
		const loads = vi.spyOn(Language, "loadSync").mockImplementation(() => {
			throw new Error("no grammar");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		newParseBatch();
		for (const i of [1, 2, 3]) expect(await fileFacts(`src/f${i}.ts`, `export const f${i} = ${i};\n`)).toBeNull();
		expect(loads).toHaveBeenCalledTimes(1);
		expect(errors.mock.calls.map(([line]) => line)).toEqual([
			"footprint: the typescript grammar failed to load: Error: no grammar",
		]);
		// Another language in the same batch is its own.
		expect(await fileFacts("src/g.js", "export const g = 1;\n")).toBeNull();
		expect(loads).toHaveBeenCalledTimes(2);
		// The next batch tries again, and this time it loads.
		loads.mockRestore();
		newParseBatch();
		expect((await fileFacts("src/f1.ts", "export const f1 = 1;\n"))?.declarations).toMatchObject([{ name: "f1" }]);
		errors.mockRestore();
	});
});
