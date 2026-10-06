import { describe, expect, it } from "vitest";
import { ago } from "../test/fixtures";
import { buildRepoRows, filterRepos, openTaskId, repoCounts, type Summaries } from "./repos";

describe("the repositories list", () => {
	const summaries: Summaries = {
		tasks: [
			{ id: "open-my-app", repo: "my-app", createdAt: ago(600), elected: true, summary: { open: 2, needsYou: 1, merged: 1, abandoned: 1, lastActivity: ago(2), countedAt: ago(1) } },
			{ id: "old", repo: "my-app", createdAt: ago(5000), summary: { open: 9, countedAt: ago(1) } },
			{ id: "planned", repo: "my-app", createdAt: ago(1), summary: null },
		],
		free: [{ repo: "docs-site", since: ago(1000), summary: { open: 1, merged: 3, violations: 1, lastActivity: ago(5), countedAt: ago(1) } }],
	};

	it("lists open-mode and coordinator-free repos together, most recently active first", () => {
		const rows = buildRepoRows(summaries);
		expect(rows.map((row) => [row.name, row.mode])).toEqual([
			["my-app", "elected"],
			["docs-site", "coordinator-free"],
		]);
		expect(rows[0]).toMatchObject({ taskId: "open-my-app", open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), detailed: true });
		expect(rows[1]).toMatchObject({ open: 1, violations: 1, merged: 3, lastActivity: ago(5), detailed: true });
		expect(repoCounts(rows[0])).toBe("2 open");
		expect(repoCounts(rows[1])).toBe("1 open · 1 violation");
	});

	it("marks repos the server hasn't counted yet", () => {
		expect(buildRepoRows({ tasks: [], free: [{ repo: "docs-site", since: ago(10), summary: null }] })[0]).toMatchObject({ detailed: false, open: 0, lastActivity: ago(10) });
	});

	it("shows one row per repo: its open-mode task, the newest if there are several", () => {
		const rows = buildRepoRows({ ...summaries, free: [] });
		expect(rows).toHaveLength(1);
		expect(rows[0].taskId).toBe("open-my-app");
	});

	it("filters by name", () => {
		const rows = buildRepoRows(summaries);
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
