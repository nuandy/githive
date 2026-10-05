import { describe, expect, it } from "vitest";
import { makeChange, makeTask } from "../test/fixtures";
import { conflictsByChange, conflictsFor, describeConflict, newestChecks } from "./conflicts";

const check = (a: string, b: string, status: "clean" | "conflict" | "disjoint", checkedAt: string, files: string[] = []) => ({ pair: [a, b] as [string, string], heads: ["x", "y"] as [string, string], status, files, checkedAt });

describe("conflicts", () => {
	const task = makeTask({
		slices: [makeChange({ id: "ui", title: "New UI" }), makeChange({ id: "api", title: "API change" }), makeChange({ id: "done", status: "integrated" })],
		checks: [
			check("api", "ui", "clean", "2026-10-01T00:00:00Z"),
			check("ui", "api", "conflict", "2026-10-02T00:00:00Z", ["src/shared.ts"]),
			check("base", "ui", "conflict", "2026-10-02T00:00:00Z", ["package.json"]),
			check("done", "api", "conflict", "2026-10-03T00:00:00Z", ["x.ts"]),
		],
	});

	it("uses only the newest check of each pair, whichever way round", () => {
		expect(newestChecks(task)).toHaveLength(3);
		expect(newestChecks(task).find((c) => c.pair.includes("api") && c.pair.includes("ui"))?.status).toBe("conflict");
	});

	it("reports each open change's conflicts with main and other open changes, not ended ones", () => {
		expect(conflictsFor(task, "ui")).toEqual([
			{ with: "api", withTitle: "API change", files: ["src/shared.ts"], checkedAt: "2026-10-02T00:00:00Z" },
			{ with: "main", withTitle: undefined, files: ["package.json"], checkedAt: "2026-10-02T00:00:00Z" },
		]);
		expect(conflictsFor(task, "api").map((c) => c.with)).toEqual(["ui"]);
		expect(conflictsByChange(task).has("done")).toBe(false);
	});

	it("words a conflict for people", () => {
		expect(describeConflict({ with: "api", withTitle: "API change", files: ["a.ts", "b.ts"] })).toBe("Conflicts with API change (api) in a.ts, b.ts");
		expect(describeConflict({ with: "main", files: [] })).toBe("Conflicts with main");
	});

	it("copes with older records without checks", () => {
		expect(conflictsFor({ slices: [makeChange()] } as never, "add-stats")).toEqual([]);
	});
});
