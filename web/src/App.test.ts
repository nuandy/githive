import { describe, expect, it } from "vitest";
import { headingOf } from "./App";

// The window title names the page, most particular first, so tabs and history tell them apart.

describe("the window title", () => {
	it("titles each repo tab, file and missing page", () => {
		const repo = "acme/storefront";
		expect(headingOf({ page: "repo", repo, tab: "changes" }, 0, "").title).toBe("Changes · acme/storefront · GitHive");
		expect(headingOf({ page: "repo", repo, tab: "hive" }, 0, "").title).toBe("acme/storefront · GitHive");
		expect(headingOf({ page: "repo", repo, tab: "code", path: "src/lib/cart.ts" }, 0, "").title).toBe(
			"cart.ts · src/lib · acme/storefront · GitHive",
		);
		expect(headingOf({ page: "repo", repo, tab: "code", path: "README.md" }, 0, "").title).toBe(
			"README.md · acme/storefront · GitHive",
		);
		expect(headingOf({ page: "repo", repo, tab: "code", path: "" }, 0, "").title).toBe(
			"Code · acme/storefront · GitHive",
		);
		expect(headingOf({ page: "not-found" }, 0, "").title).toBe("Page not found · GitHive");
	});

	it("counts what waits on you first, on every page", () => {
		expect(headingOf({ page: "repos" }, 2, "").title).toBe("(2) Repositories · GitHive");
		expect(headingOf({ page: "inbox" }, 2, "").title).toBe("(2) Inbox · GitHive");
		expect(headingOf({ page: "inbox" }, 0, "").title).toBe("Inbox · GitHive");
		expect(headingOf({ page: "repo", repo: "acme/docs", tab: "audit" }, 1, "").title).toBe(
			"(1) Audit · acme/docs · GitHive",
		);
	});
});

describe("your agents' page", () => {
	it("is titled Your agents, in the window and the breadcrumbs, apart from a repo's Agents tab", () => {
		const { crumbs, title } = headingOf({ page: "agents-settings" }, 0, "");
		expect(title).toBe("Your agents · GitHive");
		expect(crumbs).toEqual([{ label: "Your agents" }]);
	});
});
