import { describe, expect, it } from "vitest";
import { type Block, type Inline, isMarkdown, linkTarget, parseInline, parseMarkdown } from "./markdown";

const text = (value: string): Inline => ({ kind: "text", text: value });

describe("Markdown blocks", () => {
	it("reads headings, paragraphs and rules", () => {
		expect(parseMarkdown("# Storefront\n\nAcme's web shop,\nbuilt with Vite.\n\n---\n\n### Three ###")).toEqual([
			{ kind: "heading", level: 1, children: [text("Storefront")] },
			{ kind: "paragraph", children: [text("Acme's web shop,\nbuilt with Vite.")] },
			{ kind: "rule" },
			{ kind: "heading", level: 3, children: [text("Three")] },
		]);
		// Setext headings, and a "#" without a space is just text.
		expect(parseMarkdown("Title\n=====\nSub\n---\n#hashtag")).toEqual([
			{ kind: "heading", level: 1, children: [text("Title")] },
			{ kind: "heading", level: 2, children: [text("Sub")] },
			{ kind: "paragraph", children: [text("#hashtag")] },
		]);
	});

	it("keeps fenced and indented code as it is, with its language", () => {
		expect(parseMarkdown("```sh\nnpm ci\n\nnpm test  # *not* emphasis\n```\n\n    indented\n      more")).toEqual([
			{ kind: "code", lang: "sh", text: "npm ci\n\nnpm test  # *not* emphasis" },
			{ kind: "code", lang: "", text: "indented\n  more" },
		]);
		// An unclosed fence runs to the end.
		expect(parseMarkdown("~~~\na\nb")).toEqual([{ kind: "code", lang: "", text: "a\nb" }]);
	});

	it("reads lists, nested and ordered, and blockquotes", () => {
		const blocks = parseMarkdown("- one\n- two\n  - deep\n- three\n\n3. third\n4. fourth\n\n> quoted\n> **still**");
		expect(blocks[0]).toEqual({
			kind: "list",
			ordered: false,
			start: 1,
			items: [
				[{ kind: "paragraph", children: [text("one")] }],
				[
					{ kind: "paragraph", children: [text("two")] },
					{ kind: "list", ordered: false, start: 1, items: [[{ kind: "paragraph", children: [text("deep")] }]] },
				],
				[{ kind: "paragraph", children: [text("three")] }],
			],
		} satisfies Block);
		expect(blocks[1]).toMatchObject({ kind: "list", ordered: true, start: 3 });
		expect(blocks[2]).toEqual({
			kind: "quote",
			children: [{ kind: "paragraph", children: [text("quoted\n"), { kind: "strong", children: [text("still")] }] }],
		});
	});

	it("reads a simple table, with its columns' alignment and escaped pipes", () => {
		expect(parseMarkdown("| Folder | What's in it |\n| :--- | ---: |\n| `src/` | UI \\| logic |\n| docs | |")).toEqual([
			{
				kind: "table",
				align: ["left", "right"],
				head: [[text("Folder")], [text("What's in it")]],
				rows: [
					[[{ kind: "code", text: "src/" }], [text("UI | logic")]],
					[[text("docs")], []],
				],
			},
		]);
	});

	it("never passes raw HTML through: it's text", () => {
		expect(parseMarkdown('<img src=x onerror="alert(1)">\n<script>alert(1)</script>')).toEqual([
			{ kind: "paragraph", children: [text('<img src=x onerror="alert(1)">\n<script>alert(1)</script>')] },
		]);
	});

	it("resolves reference links and leaves their definitions out", () => {
		expect(
			parseMarkdown("See [the guide][g] and [docs].\n\n[g]: docs/guide.md\n[docs]: https://example.com 'Docs'"),
		).toEqual([
			{
				kind: "paragraph",
				children: [
					text("See "),
					{ kind: "link", href: "docs/guide.md", children: [text("the guide")] },
					text(" and "),
					{ kind: "link", href: "https://example.com", children: [text("docs")] },
					text("."),
				],
			},
		]);
	});
});

describe("Markdown inlines", () => {
	it("reads emphasis, strong, strikethrough and code", () => {
		expect(parseInline("a *b* __c__ ~~d~~ `e*f`")).toEqual([
			text("a "),
			{ kind: "em", children: [text("b")] },
			text(" "),
			{ kind: "strong", children: [text("c")] },
			text(" "),
			{ kind: "del", children: [text("d")] },
			text(" "),
			{ kind: "code", text: "e*f" },
		]);
		// Underscores inside a word, and a lone star, are just characters.
		expect(parseInline("snake_case_name and 2 * 3")).toEqual([text("snake_case_name and 2 * 3")]);
		expect(parseInline("**bold *and italic***")).toEqual([
			{ kind: "strong", children: [text("bold "), { kind: "em", children: [text("and italic")] }] },
		]);
	});

	it("reads links, autolinks and images, and escapes", () => {
		expect(parseInline('[the *docs*](docs/a.md "title") <https://x.dev> https://y.dev/a. \\*no\\*')).toEqual([
			{ kind: "link", href: "docs/a.md", children: [text("the "), { kind: "em", children: [text("docs")] }] },
			text(" "),
			{ kind: "link", href: "https://x.dev", children: [text("https://x.dev")] },
			text(" "),
			{ kind: "link", href: "https://y.dev/a", children: [text("https://y.dev/a")] },
			text(". *no*"),
		]);
		expect(parseInline("![build](https://ci/badge.svg)")).toEqual([
			{ kind: "image", src: "https://ci/badge.svg", alt: "build" },
		]);
	});

	it("breaks a line where it ends in two spaces or a backslash, and decodes entities", () => {
		expect(parseInline("one  \ntwo\\\nthree &amp; &copy; &#169; &lt;b&gt;")).toEqual([
			text("one"),
			{ kind: "break" },
			text("two"),
			{ kind: "break" },
			text("three & © © <b>"),
		]);
	});
});

describe("where a Markdown link goes", () => {
	const at = { repo: "acme/web", dir: "docs", ref: undefined };

	it("opens http and https outside, and a relative path in the Code tab, beside the file", () => {
		expect(linkTarget("https://example.com/a?b#c", at)).toEqual({ href: "https://example.com/a?b#c", external: true });
		expect(linkTarget("guide.md", at)).toEqual({ href: "#/repos/acme/web/code/docs/guide.md", external: false });
		expect(linkTarget("./img/a.png#x", at)).toEqual({ href: "#/repos/acme/web/code/docs/img/a.png", external: false });
		expect(linkTarget("../src/lib/currency.ts", at)).toEqual({
			href: "#/repos/acme/web/code/src/lib/currency.ts",
			external: false,
		});
		expect(linkTarget("/LICENSE", { ...at, ref: "release/2.4" })).toEqual({
			href: "#/repos/acme/web/code/LICENSE?ref=release%2F2.4",
			external: false,
		});
	});

	it("goes nowhere for any other scheme, a fragment, or a path out of the repo", () => {
		for (const url of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"java\tscript:alert(1)",
			" javascript:alert(1)",
			"data:text/html,<script>",
			"vbscript:x",
			"mailto:a@b.c",
			"//evil.example/x",
			"#section",
			"../../../etc/passwd",
			"",
		])
			expect(linkTarget(url, at), url).toBeNull();
	});
});

describe("Markdown files", () => {
	it("are told by their extension", () => {
		expect(isMarkdown("README.md")).toBe(true);
		expect(isMarkdown("docs/Guide.MARKDOWN")).toBe(true);
		expect(isMarkdown("src/a.ts")).toBe(false);
		expect(isMarkdown("md")).toBe(false);
	});
});
