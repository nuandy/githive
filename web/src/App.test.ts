import { describe, expect, it } from "vitest";
import { headingOf, unreadableRepoNotice } from "./App";

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
		expect(headingOf({ page: "repo", repo, tab: "settings", section: "general" }, 0, "").title).toBe(
			"Settings · acme/storefront · GitHive",
		);
		expect(headingOf({ page: "repo", repo, tab: "settings", section: "branch-rules" }, 0, "").title).toBe(
			"Branch rules · Settings · acme/storefront · GitHive",
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

	it("names a repo in the breadcrumbs as its owner, a place of its own, then its name, which switches repos", () => {
		expect(headingOf({ page: "repo", repo: "acme/storefront", tab: "hive" }, 0, "").crumbs).toEqual([
			{ label: "acme", href: "#/orgs/acme" },
			{ label: "storefront", href: "#/repos/acme/storefront", repo: "acme/storefront" },
		]);
		expect(
			headingOf({ page: "change", repo: "acme/storefront", change: "c", tab: "conversation" }, 0, "Cache it").crumbs,
		).toEqual([
			{ label: "acme", href: "#/orgs/acme" },
			{ label: "storefront", href: "#/repos/acme/storefront", repo: "acme/storefront" },
			{ label: "Cache it" },
		]);
		// A repo in no org yet has no owner to go to.
		expect(headingOf({ page: "repo", repo: "_/loose", tab: "hive" }, 0, "").crumbs).toEqual([
			{ label: "loose", href: "#/repos/_/loose", repo: "_/loose" },
		]);
	});
});

describe("your agents' page", () => {
	it("is titled Your agents, in the window and the breadcrumbs, apart from a repo's Agents tab", () => {
		const { crumbs, title } = headingOf({ page: "agents-settings" }, 0, "");
		expect(title).toBe("Your agents · GitHive");
		expect(crumbs).toEqual([{ label: "Your agents" }]);
	});
});

describe("a repo signed out", () => {
	it("says one the visitor can't read is private, or doesn't exist, on the sign-in card", () => {
		expect(unreadableRepoNotice("acme/docs")).toBe("acme/docs is private, or doesn't exist. Sign in to see it.");
	});
});
