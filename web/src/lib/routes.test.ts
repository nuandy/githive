import { describe, expect, it } from "vitest";
import { isLoose, repoPath, splitRepo } from "./repoName";
import { hiveQuery, href, parseRoute, readQuery, SETTINGS_SECTIONS, withHiveQuery, withQuery } from "./routes";

describe("hash routes", () => {
	it("parses the pages", () => {
		expect(parseRoute("")).toEqual({ page: "repos" });
		expect(parseRoute("#/")).toEqual({ page: "repos" });
		expect(parseRoute("#/inbox")).toEqual({ page: "inbox" });
		expect(parseRoute("#/settings/agents")).toEqual({ page: "agents-settings" });
		expect(parseRoute(href.agents())).toEqual({ page: "agents-settings" });
		expect(parseRoute("#/admin")).toEqual({ page: "admin" });
		expect(parseRoute(href.admin())).toEqual({ page: "admin" });
		expect(parseRoute("#/admin/x")).toEqual({ page: "not-found" });
		expect(parseRoute("#/new")).toEqual({ page: "new-repo" });
		expect(parseRoute("#/new?owner=acme")).toEqual({ page: "new-repo", owner: "acme" });
		expect(parseRoute("#/orgs")).toEqual({ page: "orgs" });
		expect(parseRoute("#/orgs/acme")).toEqual({ page: "org", org: "acme" });
		expect(parseRoute("#/repos/acme/web")).toEqual({ page: "repo", repo: "acme/web", tab: "hive" });
		expect(parseRoute("#/repos/acme/web/settings")).toMatchObject({ repo: "acme/web", tab: "settings" });
		for (const tab of ["changes", "history", "claims", "agents", "audit"])
			expect(parseRoute(`#/repos/acme/web/${tab}`)).toMatchObject({ page: "repo", tab });
		expect(parseRoute("#/repos/acme/web/changes/add-stats")).toEqual({
			page: "change",
			repo: "acme/web",
			change: "add-stats",
			tab: "conversation",
		});
		expect(parseRoute("#/repos/acme/web/changes/add-stats/commits")).toMatchObject({ page: "change", tab: "commits" });
		// A repo not yet in an org, as an Access admin sees it.
		expect(parseRoute("#/repos/_/walkthrough-01774")).toMatchObject({ page: "repo", repo: "_/walkthrough-01774" });
	});

	it("rejects what it doesn't know", () => {
		expect(parseRoute("#/nope")).toEqual({ page: "not-found" });
		expect(parseRoute("#/settings")).toEqual({ page: "not-found" });
		expect(parseRoute("#/settings/agents/x")).toEqual({ page: "not-found" });
		expect(parseRoute("#/free/docs-site")).toEqual({ page: "not-found" });
		// One segment is no longer a repo: a repo has an owner.
		expect(parseRoute("#/repos/my-app")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/acme/web/insights")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/acme/web/changes/x/files")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/acme/%E0%A4%A")).toEqual({ page: "not-found" });
		expect(parseRoute("#/orgs/a/b")).toEqual({ page: "not-found" });
	});

	it("builds links that parse back", () => {
		expect(href.repo("acme/web")).toBe("#/repos/acme/web");
		expect(href.repo("acme/web", "audit")).toBe("#/repos/acme/web/audit");
		expect(href.repo("acme/web", "changes", "next")).toBe("#/repos/acme/web/changes?branch=next");
		expect(href.repo("_/old-repo")).toBe("#/repos/_/old-repo");
		expect(href.change("acme/web", "add-stats", "commits")).toBe("#/repos/acme/web/changes/add-stats/commits");
		expect(href.newRepo()).toBe("#/new");
		expect(href.newRepo("acme")).toBe("#/new?owner=acme");
		expect(href.org("acme")).toBe("#/orgs/acme");
		for (const link of [
			href.repo("acme/a b", "settings"),
			href.change("acme/web", "c d", "commits"),
			href.org("x y"),
		]) {
			expect(parseRoute(link).page).not.toBe("not-found");
		}
		expect(parseRoute(href.change("acme/a b", "c d"))).toMatchObject({ repo: "acme/a b", change: "c d" });
		expect(parseRoute(href.org("acme"))).toEqual({ page: "org", org: "acme" });
	});

	it("opens Settings at a section, General when none is named", () => {
		expect(parseRoute("#/repos/acme/web/settings")).toEqual({
			page: "repo",
			repo: "acme/web",
			tab: "settings",
			section: "general",
		});
		for (const section of SETTINGS_SECTIONS)
			expect(parseRoute(`#/repos/acme/web/settings/${section}`)).toEqual({
				page: "repo",
				repo: "acme/web",
				tab: "settings",
				section,
			});
		expect(parseRoute("#/repos/acme/web/settings/nope")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/acme/web/settings/review/x")).toEqual({ page: "not-found" });
		// Only Settings has sections.
		expect(parseRoute("#/repos/acme/web/audit/review")).toEqual({ page: "not-found" });
		expect(href.settings("acme/web")).toBe("#/repos/acme/web/settings");
		expect(href.settings("acme/web", "general")).toBe("#/repos/acme/web/settings");
		expect(href.settings("acme/web", "branch-rules")).toBe("#/repos/acme/web/settings/branch-rules");
		expect(parseRoute(href.settings("acme/a b", "danger-zone"))).toMatchObject({
			repo: "acme/a b",
			section: "danger-zone",
		});
	});

	it("keeps the Changes list's filter in the address, beside its branch", () => {
		expect(parseRoute("#/repos/acme/web/changes?filter=needs-you")).toEqual({
			page: "repo",
			repo: "acme/web",
			tab: "changes",
			filter: "needs-you",
		});
		expect(parseRoute("#/repos/acme/web/changes?branch=next&filter=landing")).toMatchObject({
			branch: "next",
			filter: "landing",
		});
		expect(href.changes("acme/web", { filter: "needs-you" })).toBe("#/repos/acme/web/changes?filter=needs-you");
		expect(href.changes("acme/web", { branch: "release/2.4", filter: "in-review" })).toBe(
			"#/repos/acme/web/changes?branch=release%2F2.4&filter=in-review",
		);
		expect(href.changes("acme/web", {})).toBe(href.repo("acme/web", "changes"));
		expect(parseRoute(href.changes("acme/web", { branch: "a b", filter: "approved" }))).toMatchObject({
			tab: "changes",
			branch: "a b",
			filter: "approved",
		});
	});

	it("puts files in the Code tab's path, encoded per segment", () => {
		expect(href.code("acme/web")).toBe("#/repos/acme/web/code");
		expect(href.code("acme/web", "src/a b.ts")).toBe("#/repos/acme/web/code/src/a%20b.ts");
		expect(href.code("acme/web", "", "abc")).toBe("#/repos/acme/web/code?ref=abc");
		expect(parseRoute(href.code("acme/web", "src/x#y.ts", "feature/1"))).toMatchObject({
			repo: "acme/web",
			path: "src/x#y.ts",
			ref: "feature/1",
		});
	});
});

describe("views in the address", () => {
	it("keeps the repo search on Repositories, as ?q=", () => {
		expect(parseRoute("#/?q=store")).toEqual({ page: "repos", q: "store" });
		expect(parseRoute("#/?q=")).toEqual({ page: "repos" });
		expect(parseRoute("#?q=a%20b")).toEqual({ page: "repos", q: "a b" });
		expect(href.repos()).toBe("#/");
		expect(href.repos("")).toBe("#/");
		expect(href.repos("a b&c")).toBe("#/?q=a%20b%26c");
		expect(parseRoute(href.repos("a b&c"))).toEqual({ page: "repos", q: "a b&c" });
	});

	it("opens a change at its decision with ?decide", () => {
		expect(parseRoute("#/repos/acme/web/changes/add-stats?decide")).toEqual({
			page: "change",
			repo: "acme/web",
			change: "add-stats",
			tab: "conversation",
			decide: true,
		});
		expect(parseRoute("#/repos/acme/web/changes/add-stats?decide=1")).toMatchObject({ decide: true });
		expect(parseRoute("#/repos/acme/web/changes/add-stats")).not.toHaveProperty("decide");
		expect(href.change("acme/web", "add-stats", "conversation", { decide: true })).toBe(
			"#/repos/acme/web/changes/add-stats?decide",
		);
		expect(href.change("acme/web", "add stats", undefined, { decide: true })).toBe(
			"#/repos/acme/web/changes/add%20stats?decide",
		);
		expect(href.change("acme/web", "add-stats", "conversation", { decide: false })).toBe(
			"#/repos/acme/web/changes/add-stats",
		);
		expect(parseRoute(href.change("acme/web", "c d", "commits", { decide: true }))).toEqual({
			page: "change",
			repo: "acme/web",
			change: "c d",
			tab: "commits",
			decide: true,
		});
	});

	it("writes a query from what's set, leaving out what isn't", () => {
		expect(withQuery("#/x", {})).toBe("#/x");
		expect(withQuery("#/x", { a: "1 2", b: undefined, c: true, d: false, e: "" })).toBe("#/x?a=1%202&c");
		expect(readQuery("a=1%202&c").text("a")).toBe("1 2");
		expect(readQuery("a=1%202&c").text("b")).toBeUndefined();
		expect(readQuery("a=&c").text("a")).toBeUndefined();
		expect(readQuery("a=1%202&c").flag("c")).toBe(true);
		expect(readQuery("a=1").flag("c")).toBe(false);
	});
});

describe("the Hive tab's view in its address", () => {
	const HOUR = 60 * 60_000;

	it("reads the time window, the view, the agent shown and the row open", () => {
		const hash = "#/repos/acme/web?window=6h&view=timeline&agent=agent-7&row=links";
		expect(hiveQuery(hash)).toEqual({ window: 6 * HOUR, view: "timeline", agent: "agent-7", row: "links" });
		// Still the repo's Hive tab.
		expect(parseRoute(hash)).toEqual({ page: "repo", repo: "acme/web", tab: "hive" });
		expect(hiveQuery("#/repos/acme/web?window=15m")).toEqual({ window: 15 * 60_000 });
	});

	it("leaves out what it doesn't know", () => {
		expect(hiveQuery("#/repos/acme/web")).toEqual({});
		expect(hiveQuery("#/repos/acme/web?window=7h&view=grid&agent=&row=")).toEqual({});
	});

	it("writes them back, beside whatever else the address says, and drops what's unset", () => {
		expect(withHiveQuery("#/repos/acme/web", { window: 6 * HOUR })).toBe("#/repos/acme/web?window=6h");
		expect(withHiveQuery("#/repos/acme/web?branch=next&view=story", { view: "timeline" })).toBe(
			"#/repos/acme/web?branch=next&view=timeline",
		);
		expect(withHiveQuery("#/repos/acme/web?window=6h&row=x", {})).toBe("#/repos/acme/web");
		const odd = { agent: "service:abc/alice claude", row: "a&b" };
		expect(hiveQuery(withHiveQuery("#/repos/acme/web", odd))).toEqual(odd);
	});
});

describe("repo names", () => {
	it("splits a full name into its owner and name, and makes URL segments of them", () => {
		expect(splitRepo("acme/web")).toEqual({ owner: "acme", name: "web" });
		expect(splitRepo("lone")).toEqual({ owner: "_", name: "lone" });
		expect(repoPath("acme/my repo")).toBe("acme/my%20repo");
		expect(repoPath("_/x")).toBe("_/x");
		expect(isLoose("_/x")).toBe(true);
		expect(isLoose("acme/x")).toBe(false);
	});
});
