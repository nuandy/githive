import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormatBoundary, Markdown } from "./Markdown";

const render = (source: string, gitRef?: string) =>
	renderToStaticMarkup(<Markdown source={source} repo="acme/web" dir="docs" gitRef={gitRef} />);

describe("a Markdown file, formatted", () => {
	it("draws headings, paragraphs, emphasis, code, lists, quotes and rules as elements", () => {
		const html = render(
			"# Title\n\nSome *em* and **strong** and `code`.\n\n```sh\nnpm test\n```\n\n- a\n- b\n\n2. two\n\n> said\n\n---",
		);
		// A file's own headings sit a level under the page's: its "# Title" is an h2, under the repo's name.
		expect(html).toMatch(/<h2 class="[^"]*">Title<\/h2>/);
		expect(html).not.toContain("<h1");
		expect(html).toMatch(
			/<p class="[^"]*">Some <em>em<\/em> and <strong>strong<\/strong> and <code>code<\/code>\.<\/p>/,
		);
		expect(html).toMatch(/<pre class="[^"]*"><code>npm test<\/code><\/pre>/);
		expect(html).toMatch(/<ul class="[^"]*list-disc[^"]*"><li[^>]*><p class="[^"]*m-0[^"]*">a<\/p><\/li>/);
		expect(html).toMatch(/<ol class="[^"]*list-decimal[^"]*" start="2">/);
		expect(html).toMatch(/<blockquote class="[^"]*"><p[^>]*>said<\/p><\/blockquote>/);
		expect(html).toContain("<hr");
	});

	it("draws a table with its header and alignment", () => {
		const html = render("| a | b |\n| --- | :-: |\n| 1 | 2 |");
		expect(html).toMatch(/<th class="[^"]*text-left[^"]*">a<\/th><th class="[^"]*text-center[^"]*">b<\/th>/);
		expect(html).toMatch(/<td class="[^"]*">1<\/td>/);
		// A short row's missing cells are one empty cell across them.
		expect(render("| a | b | c |\n| - | - | - |\n| 1 |")).toMatch(
			/<td class="[^"]*">1<\/td><td colSpan="2" class="[^"]*"><\/td>/i,
		);
	});

	it("demotes every heading a level, and keeps the sixth a sixth", () => {
		const html = render("# 1\n## 2\n### 3\n#### 4\n##### 5\n###### 6");
		expect([...html.matchAll(/<(h\d)[^>]*>(\d)</g)].map(([, tag, text]) => `${tag}:${text}`)).toEqual([
			"h2:1",
			"h3:2",
			"h4:3",
			"h5:4",
			"h6:5",
			"h6:6",
		]);
	});

	it("draws a task list's boxes as checkboxes that say whether they're ticked, and can't be changed", () => {
		const html = render("- [ ] write it\n- [x] ship it");
		expect(html).toMatch(
			/<li class="[^"]*list-none[^"]*"><p[^>]*><span role="checkbox" aria-checked="false" aria-disabled="true"[^>]*><\/span>write it/,
		);
		expect(html).toMatch(
			/<span role="checkbox" aria-checked="true" aria-disabled="true"[^>]*><svg[^>]*>.*?<\/svg><\/span>ship it/,
		);
		expect(html).not.toContain("<input");
		// Each box is named by its item's words, as a checkbox is by its label.
		expect(html).toContain('aria-label="write it"');
		expect(html).toContain('aria-label="ship it"');
	});

	it("links outside in a new tab, inside to the Code tab, and nowhere for anything else", () => {
		const html = render(
			"[site](https://acme.dev) [guide](guide.md) [up](../README.md) [x](javascript:alert(1)) [y](#top)",
			"next",
		);
		expect(html).toContain('<a href="https://acme.dev" target="_blank" rel="noopener noreferrer">site</a>');
		expect(html).toContain('<a href="#/repos/acme/web/code/docs/guide.md?ref=next">guide</a>');
		expect(html).toContain('<a href="#/repos/acme/web/code/README.md?ref=next">up</a>');
		expect(html).toContain("<span>x</span>");
		expect(html).toContain("<span>y</span>");
		expect(html).not.toContain("javascript:");
	});

	it("never draws raw HTML: it shows as text", () => {
		const html = render('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n![a](javascript:alert(1))');
		expect(html).not.toMatch(/<img|<script/);
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("<span>[a]</span>");
	});
});

describe("a Markdown file that can't be formatted", () => {
	it("shows what it's given instead, and tries again when the text changes", () => {
		const props = { source: "# a", fallback: "the source", children: "formatted" };
		const boundary = new FormatBoundary(props);
		expect(boundary.render()).toBe("formatted");
		boundary.state = { ...boundary.state, ...FormatBoundary.getDerivedStateFromError() };
		expect(boundary.render()).toBe("the source");
		// The same text stays failed; another tries again.
		expect(FormatBoundary.getDerivedStateFromProps(props, boundary.state)).toBeNull();
		expect(FormatBoundary.getDerivedStateFromProps({ ...props, source: "# b" }, boundary.state)).toEqual({
			source: "# b",
			failed: false,
		});
	});

	it("is drawn nested thousands deep without running out of stack", () => {
		expect(() => render(">".repeat(5_000) + " a\n\n" + "- ".repeat(5_000) + "b")).not.toThrow();
	});
});
