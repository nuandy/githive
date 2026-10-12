import { describe, expect, it, vi } from "vitest";

// The parser and its grammars are megabytes of wasm that only a FootprintCache needs, so the Worker's isolates, which
// serve agents' calls, never load them. In a file of its own, so nothing has loaded them already.

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("web-tree-sitter", async (original) => (loaded.add("parser"), original()));
vi.mock(
	"../src/footprint/wasm/tree-sitter-typescript.wasm",
	async (original) => (loaded.add("typescript"), original()),
);
vi.mock("../src/footprint/wasm/tree-sitter-tsx.wasm", async (original) => (loaded.add("tsx"), original()));

describe("the parser", () => {
	it("isn't loaded with the Worker, only when a file is first parsed, and then only its grammar", async () => {
		await import("../src/index");
		expect(loaded).toEqual(new Set());
		const { fileFacts } = await import("../src/footprint");
		const facts = await fileFacts("src/a.ts", "export const a = 1;\n");
		expect(facts?.declarations).toMatchObject([{ name: "a" }]);
		expect(loaded).toEqual(new Set(["parser", "typescript"]));
	});
});
