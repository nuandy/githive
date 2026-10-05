import { describe, expect, it } from "vitest";
import { ago, freeSnapshot, makeChange, makeTask } from "../test/fixtures";
import { buildRepoRows, filterRepos, openTaskId, repoCounts, tasksByRepo } from "./repos";

describe("the repositories list", () => {
	const myApp = makeTask({
		createdAt: ago(600),
		slices: [
			makeChange({ id: "a", openedAt: ago(30) }),
			makeChange({ id: "b", attention: "stuck", openedAt: ago(40) }),
			makeChange({ id: "c", status: "integrated", endedAt: ago(2) }),
			makeChange({ id: "d", status: "abandoned" }),
		],
	});

	it("lists open-mode and coordinator-free repos together, most recently active first", () => {
		const rows = buildRepoRows([myApp], [{ repo: "docs-site", since: ago(1000) }], { "docs-site": freeSnapshot });
		expect(rows.map((row) => [row.name, row.mode])).toEqual([
			["my-app", "elected"],
			["docs-site", "coordinator-free"],
		]);
		expect(rows[0]).toMatchObject({ taskId: "open-my-app", open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), detailed: true });
		expect(rows[1]).toMatchObject({ open: 1, violations: 1, merged: 3, lastActivity: ago(5), detailed: true });
		expect(repoCounts(rows[0])).toBe("2 open · 1 needs you");
		expect(repoCounts(rows[1])).toBe("1 open · 1 violation");
	});

	it("marks coordinator-free repos whose details haven't loaded", () => {
		expect(buildRepoRows([], [{ repo: "docs-site", since: ago(10) }])[0]).toMatchObject({ detailed: false, open: 0 });
	});

	it("shows one row per repo: the newest open-mode task", () => {
		const older = makeTask({ id: "old", createdAt: ago(5000) });
		const planned = makeTask({ id: "planned", createdAt: ago(1), mode: undefined });
		expect(tasksByRepo([older, myApp, planned]).get("my-app")?.id).toBe("open-my-app");
	});

	it("filters by name", () => {
		const rows = buildRepoRows([myApp], [{ repo: "docs-site", since: ago(1) }]);
		expect(filterRepos(rows, "DOCS").map((row) => row.name)).toEqual(["docs-site"]);
		expect(filterRepos(rows, "  ")).toHaveLength(2);
	});
});

describe("a repo's open task id", () => {
	it("is the id the server gives the repo's open task (src/open-mode.ts openTaskId)", async () => {
		expect(await openTaskId("demo-shop")).toBe("c21a45c9");
		expect(await openTaskId("my-app")).toBe("b0645dd6");
	});
});
