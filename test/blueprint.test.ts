import { describe, expect, it } from "vitest";
import { blueprintProblems } from "../src/blueprint";
import type { Blueprint } from "../src/types";

const slice = (id: string, owns: string[]) => ({ id, title: id, owns, instructions: "" });
const blueprint = (overrides: Partial<Blueprint> = {}): Blueprint => ({
	slices: [slice("api", ["src/api/"]), slice("ui", ["src/ui/"])],
	contracts: { "src/contract.ts": "export {}" },
	...overrides,
});

describe("blueprintProblems", () => {
	it("accepts disjoint slices with the default review policy", () => {
		expect(blueprintProblems(blueprint())).toEqual([]);
	});

	it("rejects overlapping lanes", () => {
		const problems = blueprintProblems(blueprint({ slices: [slice("api", ["src/"]), slice("ui", ["src/ui/"])] }));
		expect(problems).toContain("ui owns src/ui/, which overlaps api's src/.");
	});

	it("rejects bad ids, duplicates and escaping paths", () => {
		const problems = blueprintProblems(
			blueprint({ slices: [slice("Api", ["../x/"]), slice("ui", ["a/"]), slice("ui", ["b/"]), slice("base", ["c/"])] }),
		);
		expect(problems.join("\n")).toMatch(/"Api" must be a lowercase slug/);
		expect(problems.join("\n")).toMatch(/invalid path: \.\.\/x\//);
		expect(problems.join("\n")).toMatch(/ui is used twice/);
		expect(problems.join("\n")).toMatch(/"base" must be a lowercase slug and not "base"/);
	});

	it("reports an impossible review policy instead of throwing", () => {
		const problems = blueprintProblems(blueprint({ review: { reviewers: ["tests"], required: 2, vetoes: [] } }));
		expect(problems).toEqual(["Review policy: required must be between 1 and 1"]);
	});
});

describe("slice tests", () => {
	it("must be contract files", () => {
		const problems = blueprintProblems(
			blueprint({ slices: [{ ...slice("api", ["src/api/"]), tests: ["src/contract.ts", "test/missing.test.ts"] }] }),
		);
		expect(problems).toEqual(["Slice api lists test test/missing.test.ts, which is not a contract file."]);
	});
});
