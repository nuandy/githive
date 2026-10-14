import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyPage, Page, PageHeader, SkipLink } from "./Page";

// The skip link, and the main column it skips to.

describe("the skip link", () => {
	it("casts no shadow until it takes focus", () => {
		const html = renderToStaticMarkup(<SkipLink />);
		expect(html).not.toMatch(/class="[^"]*(?<!:)shadow-raised/);
		expect(html).toContain("focus:shadow-raised");
	});

	it("lands on a main column that can take focus", () => {
		const html = renderToStaticMarkup(<Page>text</Page>);
		expect(html).toContain('id="main"');
		expect(html).toContain('tabindex="-1"');
	});
});

describe("a page's header", () => {
	it("titles the page in its one heading, which takes focus as the page changes, with a line and actions", () => {
		const html = renderToStaticMarkup(
			<PageHeader title="Inbox" description="What waits on you." actions={<button type="button">Go</button>} />,
		);
		expect(html.match(/<h1/g)).toHaveLength(1);
		expect(html).toMatch(/<h1 tabindex="-1" class="[^"]*\btext-display\b[^"]*">Inbox<\/h1>/);
		expect(html).toContain("What waits on you.");
		expect(html).toContain("<button");
	});

	it("titles a page with nothing but a message the same way", () => {
		const html = renderToStaticMarkup(
			<EmptyPage title="Page not found">
				<p>Go back.</p>
			</EmptyPage>,
		);
		expect(html).toMatch(/<h1 tabindex="-1"[^>]*>Page not found<\/h1>/);
	});
});
