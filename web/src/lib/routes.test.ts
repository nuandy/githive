import { describe, expect, it } from "vitest";
import { href, parseRoute } from "./routes";

describe("hash routes", () => {
	it("parses the pages", () => {
		expect(parseRoute("")).toEqual({ page: "repos" });
		expect(parseRoute("#/")).toEqual({ page: "repos" });
		expect(parseRoute("#/repos/my-app")).toEqual({ page: "repo", repo: "my-app", base: "repos", tab: "changes", state: "open" });
		expect(parseRoute("#/repos/my-app?state=merged")).toMatchObject({ tab: "changes", state: "merged" });
		expect(parseRoute("#/repos/my-app?state=bogus")).toMatchObject({ state: "open" });
		expect(parseRoute("#/repos/my-app/activity")).toMatchObject({ page: "repo", tab: "activity" });
		expect(parseRoute("#/repos/team%2Fapp/settings")).toMatchObject({ repo: "team/app", tab: "settings" });
		expect(parseRoute("#/repos/my-app/changes/add-stats")).toEqual({ page: "change", repo: "my-app", base: "repos", change: "add-stats", tab: "conversation" });
		expect(parseRoute("#/repos/my-app/changes/add-stats/files")).toMatchObject({ tab: "files" });
		expect(parseRoute("#/repos/my-app/changes/add-stats/checks")).toMatchObject({ tab: "checks" });
	});

	it("keeps the old coordinator-free and task links working", () => {
		expect(parseRoute("#/free/docs-site")).toEqual({ page: "repo", repo: "docs-site", base: "free", tab: "changes", state: "open" });
		expect(parseRoute("#/free/docs-site/audit")).toMatchObject({ base: "free", tab: "audit" });
		expect(parseRoute("#/tasks/open-my-app")).toEqual({ page: "task", taskId: "open-my-app" });
	});

	it("rejects what it doesn't know", () => {
		expect(parseRoute("#/nope")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/my-app/changes/x/blame")).toEqual({ page: "not-found" });
		expect(parseRoute("#/repos/%E0%A4%A")).toEqual({ page: "not-found" });
	});

	it("builds links that parse back", () => {
		expect(href.repo("team/app")).toBe("#/repos/team%2Fapp");
		expect(href.repo("my-app", "changes", "repos", "abandoned")).toBe("#/repos/my-app?state=abandoned");
		expect(href.repo("docs", "audit", "free")).toBe("#/free/docs/audit");
		expect(href.change("my-app", "add-stats", "files")).toBe("#/repos/my-app/changes/add-stats/files");
		for (const link of [href.repo("team/app", "settings"), href.change("a/b", "c d", "checks", "free")]) {
			const route = parseRoute(link);
			expect(route.page === "repo" || route.page === "change").toBe(true);
		}
		expect(parseRoute(href.change("a/b", "c d"))).toMatchObject({ repo: "a/b", change: "c d" });
	});
});
