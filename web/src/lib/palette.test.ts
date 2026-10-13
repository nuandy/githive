import { describe, expect, it } from "vitest";
import { FIRST_OF_EACH, filterPalette, paletteItems } from "./palette";

// The ⌘K palette: a repo, an open change in the repo shown, or a page, found by what's typed.

const items = paletteItems({
	repos: ["acme/storefront", "acme/docs", "robin/notes"],
	repo: "acme/storefront",
	changes: [
		{ change: "stock-sync", title: "Sync stock levels from the warehouse feed" },
		{ change: "docs-links", title: "Fix the links in the docs" },
	],
	people: true,
});

describe("the palette", () => {
	it("lists the repo's open changes, then repos, then pages", () => {
		expect(items.map((item) => [item.kind, item.label])).toEqual([
			["change", "Sync stock levels from the warehouse feed"],
			["change", "Fix the links in the docs"],
			["repo", "acme/storefront"],
			["repo", "acme/docs"],
			["repo", "robin/notes"],
			["page", "Inbox"],
			["page", "Repositories"],
			["page", "Your agents"],
			["page", "Your organizations"],
			["page", "New repository"],
		]);
		expect(items[0]).toMatchObject({
			href: "#/repos/acme/storefront/changes/stock-sync",
			detail: "stock-sync",
		});
		expect(items[3]!.href).toBe("#/repos/acme/docs");
		expect(items.find((item) => item.label === "Your agents")!.href).toBe("#/settings/agents");
	});

	it("leaves out the pages that are a person's, for an Access operator, and offers them Admin", () => {
		const theirs = paletteItems({ repos: [], people: false, operator: true });
		expect(theirs.map((item) => item.label)).toEqual(["Inbox", "Repositories", "Admin"]);
		expect(theirs.at(-1)!.href).toBe("#/admin");
		expect(paletteItems({ repos: [], people: true }).map((item) => item.label)).not.toContain("Admin");
	});

	it("finds by every word typed, a name's start first", () => {
		// A name that starts with it, then a word in a name, then anywhere in a name, then in what's said about it.
		expect(filterPalette(items, "in").map((item) => item.label)).toEqual([
			"Inbox",
			"Fix the links in the docs",
			"robin/notes",
		]);
		expect(filterPalette(items, "docs").map((item) => item.label)).toEqual(["Fix the links in the docs", "acme/docs"]);
		expect(filterPalette(items, "ACME store").map((item) => item.label)).toEqual(["acme/storefront"]);
		// By a change's id too.
		expect(filterPalette(items, "stock-sync").map((item) => item.label)).toEqual([
			"Sync stock levels from the warehouse feed",
		]);
		expect(filterPalette(items, "zzz")).toEqual([]);
	});

	it("shows the first few of each kind before anything's typed", () => {
		expect(filterPalette(items, "  ")).toEqual(items);
		expect(filterPalette(items, "", 3)).toHaveLength(3);
		const busy = paletteItems({
			repos: ["a/b"],
			repo: "a/b",
			changes: Array.from({ length: 9 }, (_, i) => ({ change: `c-${i}`, title: `Change ${i}` })),
			people: false,
		});
		expect(filterPalette(busy, "").map((item) => item.kind)).toEqual([
			...Array(FIRST_OF_EACH).fill("change"),
			"repo",
			"page",
			"page",
		]);
		// Typed for, every change can be found.
		expect(filterPalette(busy, "change")).toHaveLength(9);
	});
});
