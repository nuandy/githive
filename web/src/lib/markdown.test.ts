import { describe, expect, it } from "vitest";
import { type Block, FORMAT_MOST, type Inline, isMarkdown, linkTarget, parseInline, parseMarkdown } from "./markdown";

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
		// A closing run of #s goes only after a space; one that's all there is leaves the heading empty.
		expect(parseMarkdown("## a ### b ##\n# a#\n### ###\n#\ttabbed  #  ")).toEqual([
			{ kind: "heading", level: 2, children: [text("a ### b")] },
			{ kind: "heading", level: 1, children: [text("a#")] },
			{ kind: "heading", level: 3, children: [] },
			{ kind: "heading", level: 1, children: [text("tabbed")] },
		]);
		// A paragraph's line that ends in two spaces breaks there; its last line's spaces go.
		expect(parseMarkdown("  one  \ntwo  ")).toEqual([
			{ kind: "paragraph", children: [text("one"), { kind: "break" }, text("two")] },
		]);
	});

	it("keeps fenced and indented code as it is, with its language", () => {
		expect(parseMarkdown("```sh\nnpm ci\n\nnpm test  # *not* emphasis\n```\n\n    indented\n      more")).toEqual([
			{ kind: "code", lang: "sh", text: "npm ci\n\nnpm test  # *not* emphasis" },
			{ kind: "code", lang: "", text: "indented\n  more" },
		]);
		// An unclosed fence runs to the end.
		expect(parseMarkdown("~~~\na\nb")).toEqual([{ kind: "code", lang: "", text: "a\nb" }]);
		// Its language is the first word of what follows the fence; a backtick there makes it inline code instead.
		expect(parseMarkdown("```  ts title=x\nlet a;\n```\n\n``` `a` ```")).toEqual([
			{ kind: "code", lang: "ts", text: "let a;" },
			{ kind: "paragraph", children: [{ kind: "code", text: "`a`" }] },
		]);
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
		// A row keeps the cells it has, up to the head's: Markdown.tsx leaves the rest empty.
		expect(parseMarkdown("a | b | c\n--|--|--\n1\n1 | 2 | 3 | 4")).toEqual([
			{
				kind: "table",
				align: [null, null, null],
				head: [[text("a")], [text("b")], [text("c")]],
				rows: [[[text("1")]], [[text("1")], [text("2")], [text("3")]]],
			},
		]);
	});

	it("reads a task list's boxes, ticked or not", () => {
		const [list] = parseMarkdown("- [ ] write it\n- [x] test it\n- [X] ship it\n- [] not a box\n- [ ]");
		expect(list).toEqual({
			kind: "list",
			ordered: false,
			start: 1,
			items: [
				[{ kind: "paragraph", children: [{ kind: "task", checked: false }, text("write it")] }],
				[{ kind: "paragraph", children: [{ kind: "task", checked: true }, text("test it")] }],
				[{ kind: "paragraph", children: [{ kind: "task", checked: true }, text("ship it")] }],
				[{ kind: "paragraph", children: [text("[] not a box")] }],
				[{ kind: "paragraph", children: [text("[ ]")] }],
			],
		} satisfies Block);
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

	it("decodes a path before it resolves it, so an encoded way out of the repo goes nowhere", () => {
		for (const url of ["%2e%2e/%2e%2e/x", "%2E%2E/..", "a%2f..%2f..%2f..%2fx", "..%2F..%2Fx", "/%2e%2e/x"])
			expect(linkTarget(url, at), url).toBeNull();
		expect(linkTarget("%2e%2e/README.md", at)).toEqual({ href: "#/repos/acme/web/code/README.md", external: false });
		expect(linkTarget("a%2Fb.md", at)).toEqual({ href: "#/repos/acme/web/code/docs/a/b.md", external: false });
		// A % that starts no escape stays as it's written.
		expect(linkTarget("100%25%.md", at)).toEqual({ href: "#/repos/acme/web/code/docs/100%25%25.md", external: false });
	});

	it("drops only what a browser drops: spaces and controls at the ends, and tabs and newlines anywhere", () => {
		expect(linkTarget("my file.md", at)).toEqual({ href: "#/repos/acme/web/code/docs/my%20file.md", external: false });
		expect(linkTarget(" \u0001https://x.dev/a b\t\n", at)).toEqual({ href: "https://x.dev/a b", external: true });
		expect(linkTarget("https://x.dev/a\tb\nc\r", at)).toEqual({ href: "https://x.dev/abc", external: true });
		expect(linkTarget("java\nscript:alert(1)", at)).toBeNull();
		expect(linkTarget("\u0000 javascript:alert(1)", at)).toBeNull();
		// A file named with spaces, written in angle brackets as Markdown asks.
		expect(parseInline("[it](<docs/my file.md>)")).toEqual([
			{ kind: "link", href: "docs/my file.md", children: [text("it")] },
		]);
	});
});

describe("a hostile Markdown file", () => {
	// Agents write a repo's Markdown, so a file may be made to stall the reader or overflow its stack. Each of these
	// took seconds, or threw, at this size; each is read in a fraction of that now. Files over FORMAT_MOST show as
	// their source, so that's the size to beat.
	const size = FORMAT_MOST;
	const repeat = (unit: string) => unit.repeat(Math.floor(size / unit.length));
	const hostile: [string, string][] = [
		["a fence line with a backtick at its end", "```" + "a".repeat(size) + "`"],
		["a fence line of spaces before a backtick", "```" + " ".repeat(size) + "`"],
		["a heading with long runs of spaces", "# a" + " ".repeat(size / 2) + "a" + " ".repeat(size / 2) + "#x"],
		["emphasis that never closes", repeat("*a ")],
		["underscores that never close", repeat("_a ")],
		["strikethrough that never closes", repeat("~~a ")],
		["brackets that never close", repeat("[a ")],
		["brackets nested deep", "[".repeat(size / 2) + "]".repeat(size / 2)],
		["brackets nested deep, with a reference defined", "[x]: y\n\n" + "[".repeat(size / 2) + "]".repeat(size / 2)],
		["images nested deep", repeat("![")],
		["link destinations whose parentheses never close", repeat("[a](()")],
		["link titles whose parentheses never close", repeat("[a](b (")],
		["link destinations in angle brackets that never close", repeat("[a](<")],
		["code spans of every length", Array.from({ length: 440 }, (_, n) => "`".repeat(n + 1) + "a").join("")],
		["a bare link followed by punctuation", "http://a" + ".".repeat(size) + "x"],
		["a paragraph of many short lines", repeat("a \n")],
		["a run of spaces inside a line", "a" + " ".repeat(size) + "b\nc"],
		["a table delimiter row of spaces", "a|b\n|-" + " ".repeat(size) + "x"],
		[
			"a table's many columns over many short rows",
			`${"|".repeat(8_000)}\n${"-|".repeat(8_000)}\n${repeat("x\n").slice(0, 60_000)}`,
		],
		["a quote's lazy lines", "> a\n" + repeat("b\n")],
		["a list of dashes", repeat("- ") + "x"],
		["quotes nested deep", ">".repeat(size) + " a"],
	];
	// The best of up to three reads, so a busy machine running other tests beside this one doesn't fail it: a reader
	// that's quadratic again takes seconds every time.
	for (const [name, source] of hostile)
		it(`reads ${name} quickly`, () => {
			let best = Infinity;
			for (let tries = 0; tries < 3 && best >= 200; tries++) {
				const start = performance.now();
				parseMarkdown(source);
				best = Math.min(best, performance.now() - start);
			}
			expect(best).toBeLessThan(200);
		});

	it("reads quotes and lists nested deeper than 16 as text, without running out of stack", () => {
		const depth = (blocks: Block[]): number =>
			Math.max(
				0,
				...blocks.map((block) =>
					block.kind === "quote"
						? 1 + depth(block.children)
						: block.kind === "list"
							? 1 + Math.max(0, ...block.items.map(depth))
							: 0,
				),
			);
		const quotes = parseMarkdown(">".repeat(5_000) + " deep");
		expect(depth(quotes)).toBe(16);
		expect(JSON.stringify(quotes)).toContain("deep");
		expect(depth(parseMarkdown("- ".repeat(5_000) + "deep"))).toBe(16);
		// Emphasis and links nest as far, and no further.
		expect(() => parseInline("*".repeat(20_000) + "a" + "*".repeat(20_000))).not.toThrow();
		expect(() => parseInline("![".repeat(5_000) + "a" + "](x)".repeat(5_000))).not.toThrow();
		// Short of that, they nest as they're written.
		expect(depth(parseMarkdown("> > > three"))).toBe(3);
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
