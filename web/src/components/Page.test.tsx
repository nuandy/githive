import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Page, SkipLink } from "./Page";

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
