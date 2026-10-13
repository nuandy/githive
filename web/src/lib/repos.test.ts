import { describe, expect, it } from "vitest";
import { ago } from "../test/fixtures";
import { buildRepoRows, filterRepos, groupRepos, repoCounts, repoState, type Summaries, waitingIn } from "./repos";

describe("the repositories list", () => {
	const summaries: Summaries = {
		repos: [
			{
				repo: "acme/docs-site",
				since: ago(1000),
				summary: { open: 1, merged: 3, violations: 1, lastActivity: ago(5), countedAt: ago(1) },
			},
			{
				repo: "acme/my-app",
				since: ago(600),
				summary: { open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), countedAt: ago(1) },
			},
		],
	};

	it("lists repos most recently active first, with their counts", () => {
		const rows = buildRepoRows(summaries);
		expect(rows.map((row) => row.name)).toEqual(["acme/my-app", "acme/docs-site"]);
		expect(rows[0]).toMatchObject({ open: 2, needsYou: 1, merged: 1, lastActivity: ago(2), detailed: true });
		expect(rows[1]).toMatchObject({ open: 1, violations: 1, merged: 3, lastActivity: ago(5), detailed: true });
		expect(repoCounts(rows[0]!)).toBe("2 open");
		expect(repoCounts(rows[1]!)).toBe("1 open, 1 audit violation");
	});

	it("marks repos the server hasn't counted yet", () => {
		expect(buildRepoRows({ repos: [{ repo: "acme/docs-site", since: ago(10), summary: null }] })[0]).toMatchObject({
			detailed: false,
			open: 0,
			lastActivity: ago(10),
		});
	});

	it("counts what waits on a person as the Inbox does: changes and the audit's open violations", () => {
		const waiting = [
			{ kind: "vote" as const, role: "payments", change: "refunds", title: "Refunds", reason: "" },
			{ change: "cache", title: "Cache", reason: "Which TTL?" },
		];
		const [row] = buildRepoRows({
			repos: [{ repo: "acme/shop", since: ago(10), summary: { open: 3, needsYou: 2, violations: 1, waiting } }],
		});
		expect(row).toMatchObject({ needsYou: 2, violations: 1 });
		expect(waitingIn({ needsYou: 2, violations: 1, waiting })).toEqual({ changes: 2, violations: 1 });
		// A summary whose list is longer than its count (an older server's) counts its list.
		expect(waitingIn({ waiting })).toEqual({ changes: 2, violations: 0 });
		expect(waitingIn(null)).toEqual({ changes: 0, violations: 0 });
	});

	it("filters by name", () => {
		const rows = buildRepoRows(summaries);
		expect(filterRepos(rows, "DOCS").map((row) => row.name)).toEqual(["acme/docs-site"]);
		expect(filterRepos(rows, "  ")).toHaveLength(2);
	});
});

describe("the groups on the Repositories page", () => {
	const row = (name: string, over: Partial<Parameters<typeof repoState>[0]> = {}) => ({
		name,
		open: 0,
		needsYou: 0,
		merged: 0,
		violations: 0,
		detailed: true,
		...over,
	});

	it("puts what needs a person first, then work under way, then the quiet repos, keeping each group's order", () => {
		const rows = [
			row("a/quiet"),
			row("a/busy", { open: 2 }),
			row("a/asks", { open: 1, needsYou: 1 }),
			row("a/audit", { violations: 1 }),
			row("a/busier", { open: 5 }),
		];
		expect(groupRepos(rows).map((g) => [g.state, g.rows.map((r) => r.name)])).toEqual([
			["needs-you", ["a/asks", "a/audit"]],
			["at-work", ["a/busy", "a/busier"]],
			["quiet", ["a/quiet"]],
		]);
	});

	it("puts a repo whose work just landed in its own group, until it's been quiet a few hours", () => {
		const stretch = (minutes: number) => ({
			landed: 20,
			failed: 0,
			agents: 6,
			from: ago(minutes + 30),
			to: ago(minutes),
		});
		const rows = [
			row("a/done", { stretch: stretch(5) }),
			row("a/long-ago", { stretch: stretch(600) }),
			row("a/busy", { open: 1, stretch: stretch(5) }),
		];
		expect(groupRepos(rows).map((g) => [g.state, g.rows.map((r) => r.name)])).toEqual([
			["at-work", ["a/busy"]],
			["done", ["a/done"]],
			["quiet", ["a/long-ago"]],
		]);
	});

	it("leaves out a group with nothing in it", () => {
		expect(groupRepos([row("a/busy", { open: 1 })]).map((g) => g.state)).toEqual(["at-work"]);
	});
});
