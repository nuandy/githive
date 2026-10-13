import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (source: string, gitRef?: string) =>
	renderToStaticMarkup(<Markdown source={source} repo="acme/web" dir="docs" gitRef={gitRef} />);

describe("a Markdown file, formatted", () => {
	it("draws headings, paragraphs, emphasis, code, lists, quotes and rules as elements", () => {
		const html = render(
			"# Title\n\nSome *em* and **strong** and `code`.\n\n```sh\nnpm test\n```\n\n- a\n- b\n\n2. two\n\n> said\n\n---",
		);
		expect(html).toMatch(/<h1 class="[^"]*">Title<\/h1>/);
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
