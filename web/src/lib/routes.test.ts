import { describe, expect, it } from "vitest";
import { href, parseRoute } from "./routes";

describe("hash routes", () => {
	it("parses the pages", () => {
		expect(parseRoute("")).toEqual({ page: "repos" });
		expect(parseRoute("#/")).toEqual({ page: "repos" });
		expect(parseRoute("#/inbox")).toEqual({ page: "inbox" });
		expect(parseRoute("#/settings/agents")).toEqual({ page: "agents-settings" });
		expect(parseRoute(href.agents())).toEqual({ page: "agents-settings" });
		expect(parseRoute("#/repos/my-app")).toEqual({ page: "repo", repo: "my-app", tab: "changes" });
		expect(parseRoute("#/repos/team%2Fapp/settings")).toMatchObject({ repo: "team/app", tab: "settings" });
		for (const tab of ["claims", "agents", "audit"]) expect(parseRoute(`#/repos/my-app/${tab}`)).toMatchObject({ page: "repo", tab });
		expect(parseRoute("#/repos/my-app/changes/add-stats")).toEqual({ page: "change", repo: "my-app", change: "add-stats", tab: "conversation" });
		expect(parseRoute("#/repos/my-app/changes/add-stats/commits")).toMatchObject({ page: "change", tab: "commits" });
	});

	it("rejects what it doesn't know", () => {
		expect(parseRoute("#/nope")).toEqual({ page: "not-found" });
		expect(parseRoute("#/settings")).toEqual({ page: "not-found" });
		expect(parseRoute("#/settings/agents/x")).toEqual({ page: "not-found" });
		expect(parseRoute("#/free/docs-site")).toEqual({ page: "not-found" });
		expect(parseRoute("#/tasks/open-my-app")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/my-app/insights")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/my-app/changes/x/files")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/%E0%A4%A")).toEqual({ page: "not-found" });
	});

	it("builds links that parse back", () => {
		expect(href.repo("team/app")).toBe("#/repos/team%2Fapp");
		expect(href.repo("docs", "audit")).toBe("#/repos/docs/audit");
		expect(href.change("my-app", "add-stats", "commits")).toBe("#/repos/my-app/changes/add-stats/commits");
		for (const link of [href.repo("team/app", "settings"), href.change("a/b", "c d", "commits")]) {
			const route = parseRoute(link);
			expect(route.page === "repo" || route.page === "change").toBe(true);
		}
		expect(parseRoute(href.change("a/b", "c d"))).toMatchObject({ repo: "a/b", change: "c d" });
	});

	it("parses and builds code links", () => {
		expect(parseRoute("#/repos/my-app/code")).toEqual({ page: "repo", repo: "my-app", tab: "code", path: "" });
		expect(parseRoute("#/repos/my-app/code/src/stats/page.tsx")).toMatchObject({ tab: "code", path: "src/stats/page.tsx" });
		expect(parseRoute("#/repos/docs/code/a%20b/c.md?ref=abc123")).toMatchObject({ tab: "code", path: "a b/c.md", ref: "abc123" });
		expect(href.code("my-app")).toBe("#/repos/my-app/code");
		expect(href.code("my-app", "src/a b.ts")).toBe("#/repos/my-app/code/src/a%20b.ts");
		expect(href.code("docs", "", "abc")).toBe("#/repos/docs/code?ref=abc");
		expect(parseRoute(href.code("team/app", "src/x#y.ts", "feature/1"))).toMatchObject({ repo: "team/app", path: "src/x#y.ts", ref: "feature/1" });
		expect(href.inbox()).toBe("#/inbox");
	});
});
