import { describe, expect, it } from "vitest";
import { pushFeedback } from "../src/builder-feedback";
import type { MergeCheck } from "../src/types";

const check = (pair: [string, string], status: MergeCheck["status"], files: string[] = []): MergeCheck => ({
	pair,
	heads: ["a", "b"],
	status,
	files,
	checkedAt: "2026-10-02T00:00:00Z",
});
const siblings = [{ id: "ui", title: "UI", owns: ["src/ui/"] }];

describe("pushFeedback", () => {
	it("says so when everything is clean", () => {
		expect(pushFeedback("api", [], [check(["api", "ui"], "disjoint")], siblings)).toMatch(/No conflicts/);
	});

	it("names lane violations and conflicts with the other slice's lane", () => {
		const text = pushFeedback("api", ["src/shared.ts"], [check(["api", "ui"], "conflict", ["src/shared.ts"])], siblings);
		expect(text).toMatch(/outside your lane.*src\/shared\.ts/);
		expect(text).toMatch(/Conflict with slice ui in src\/shared\.ts\. ui owns src\/ui\//);
	});

	it("explains conflicts with already-integrated work", () => {
		expect(pushFeedback("api", [], [check(["api", "base"], "conflict", ["x.ts"])], [])).toMatch(/task base/);
	});

	it("ignores conflicts between other slices", () => {
		expect(pushFeedback("api", [], [check(["ui", "web"], "conflict", ["x.ts"])], siblings)).toMatch(/No conflicts/);
	});
});
