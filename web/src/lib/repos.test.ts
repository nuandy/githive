import { describe, expect, it } from "vitest";
import { ago } from "../test/fixtures";
import { buildRepoRows, filterRepos, repoCounts, type Summaries } from "./repos";

describe("the repositories list", () => {
	const summaries: Summaries = {
		repos: [
			{ repo: "acme/docs-site", since: ago(1000), summary: { open: 1, merged: 3, violations: 1, lastActivity: ago(5), countedAt: ago(1) } },
			{ repo: "acme/my-app", since: ago(600), summary: { open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), countedAt: ago(1) } },
		],
	};

	it("lists repos most recently active first, with their counts", () => {
		const rows = buildRepoRows(summaries);
		expect(rows.map((row) => row.name)).toEqual(["acme/my-app", "acme/docs-site"]);
		expect(rows[0]).toMatchObject({ open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), detailed: true });
		expect(rows[1]).toMatchObject({ open: 1, violations: 1, merged: 3, lastActivity: ago(5), detailed: true });
		expect(repoCounts(rows[0])).toBe("2 open");
		expect(repoCounts(rows[1])).toBe("1 open · 1 violation");
	});

	it("marks repos the server hasn't counted yet", () => {
		expect(buildRepoRows({ repos: [{ repo: "acme/docs-site", since: ago(10), summary: null }] })[0]).toMatchObject({ detailed: false, open: 0, lastActivity: ago(10) });
	});

	it("filters by name", () => {
		const rows = buildRepoRows(summaries);
		expect(filterRepos(rows, "DOCS").map((row) => row.name)).toEqual(["acme/docs-site"]);
		expect(filterRepos(rows, "  ")).toHaveLength(2);
	});
});
