import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleText } from "../test/fixtures";
import { RepoHeader } from "./RepoHeader";
import { ShardingBadge } from "./StatusPill";

// The header over every page in a repo: its name is the page's heading, unless the page has one of its own.

describe("the repo header", () => {
	it("names the repo, and only the repo, in its heading", () => {
		const html = renderToStaticMarkup(
			<RepoHeader
				name="acme/storefront"
				tabs={[]}
				current="hive"
				homeHref="#/"
				badges={
					<ShardingBadge summary={{ label: "Sharded votes", sharded: true, detail: "Votes are split by commit." }} />
				}
			/>,
		);
		const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? "";
		expect(visibleText(h1).trim()).toBe("acme/storefront");
		expect(html).toContain("Sharded votes");
	});

	it("leaves the heading to a page that has its own", () => {
		const html = renderToStaticMarkup(
			<RepoHeader name="acme/storefront" tabs={[]} current="changes" homeHref="#/" heading={false} />,
		);
		expect(html).not.toContain("<h1");
		expect(visibleText(html)).toContain("acme/storefront");
	});
});
