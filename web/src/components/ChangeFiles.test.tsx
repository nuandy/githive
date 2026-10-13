import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeDiff, FileDiff } from "../api";
import { inlineText, visibleText } from "../test/fixtures";
import { ChangeFiles } from "./ChangeFiles";

// A change's Files tab: a fold per file, with its path, how many lines it adds and removes, whether it's outside the
// change's claim, and its lines.

const modified: FileDiff = {
	path: "src/lib/currency.ts",
	status: "modified",
	added: 2,
	removed: 1,
	hunks: [
		{
			oldStart: 10,
			oldLines: 3,
			newStart: 10,
			newLines: 4,
			lines: [
				" export function tax() {",
				"-  return 0;",
				"+  const rate = rateFor(country);",
				"+  return total * rate;",
				" }",
			],
		},
	],
};
const long: FileDiff = {
	path: "src/data/rates.json",
	status: "added",
	added: 400,
	removed: 0,
	outside: true,
	hunks: [
		{
			oldStart: 0,
			oldLines: 0,
			newStart: 1,
			newLines: 400,
			lines: Array.from({ length: 400 }, (_, index) => `+  "r${index}": 0.${index},`),
		},
	],
};
const diff: ChangeDiff = {
	change: "checkout-tax",
	of: "head",
	base: "aaaaaaa1111111",
	head: "4e6df04bbbbbbb",
	total: 4,
	files: [
		long,
		modified,
		{ path: "public/og/card.png", status: "added", binary: true },
		{ path: "package-lock.json", status: "modified", tooBig: true },
	],
};

const render = (props: Partial<Parameters<typeof ChangeFiles>[0]> = {}) =>
	renderToStaticMarkup(
		<ChangeFiles repo="acme/storefront" changeId="checkout-tax" diff={diff} head={diff.head} into="main" {...props} />,
	);

describe("a change's files", () => {
	it("counts them, and shows each file's path, its lines added and removed, and what's outside the claim", () => {
		const text = visibleText(render());
		expect(text).toContain("4 files changed");
		expect(text).toContain("+402");
		expect(text).toContain("−1");
		expect(text).toContain("src/lib/currency.ts");
		expect(text).toMatch(/src\/data\/rates\.json .*outside its claim/);
		expect(text).toContain("Binary file: not shown.");
		expect(text).toContain("Too big to show here");
	});

	it("shows hunk headers and each line in the diff colors, with its line numbers", () => {
		const html = render();
		expect(visibleText(html)).toContain("@@ -10,3 +10,4 @@");
		expect(html).toMatch(/<tr class="[^"]*bg-diff-add[^"]*"><td[^>]*>[^<]*<\/td><td[^>]*>11<\/td>/);
		expect(html).toMatch(/<tr class="[^"]*bg-diff-del[^"]*"><td[^>]*>11<\/td>/);
		expect(html).toContain("return total * rate;");
	});

	it("starts a long file folded, and the file asked for open", () => {
		const folded = render();
		expect(folded).not.toContain('"r399"');
		expect(folded).toMatch(/<details class="disclosure[^"]*"[^>]*><summary[^>]*>.*src\/data\/rates\.json/);
		expect(render({ file: "src/data/rates.json" })).toContain("&quot;r399&quot;");
	});

	it("says when it shows an earlier push, and when there's nothing to show", () => {
		expect(visibleText(render({ head: "9999999ccccccc" }))).toContain("an earlier push");
		expect(visibleText(render({ diff: { ...diff, base: null, head: null, files: [], total: 0 } }))).toContain(
			"Nothing is pushed yet",
		);
		expect(visibleText(render({ diff: undefined }))).toContain("Reading its files");
		expect(inlineText(render({ diff: null, error: "Artifacts is busy" }))).toContain(
			"This change's files couldn't be loaded: Artifacts is busy.",
		);
		expect(visibleText(render({ diff: { ...diff, total: 320 } }))).toContain("And 316 more files");
	});

	it("shows a landed change as what it brought to its branch", () => {
		expect(visibleText(render({ diff: { ...diff, of: "landed" } }))).toMatch(/as it landed on main/);
	});
});
