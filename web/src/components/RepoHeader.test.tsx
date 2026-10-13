import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { repoSnapshot, stubApi, visibleText } from "../test/fixtures";
import { RepoHeader } from "./RepoHeader";
import { NOT_STARTED_TAB, RepoPage, repoTabs } from "./RepoPage";
import { Tabs } from "./Tabs";

// The header over every page in a repo: its name is the page's heading, unless the page has one of its own; who can
// see it and whether it's live beside it; its tabs, which stick under the top bar.

describe("the repo header", () => {
	it("names the repo, and only the repo, in its heading, and says who can see it beside it", () => {
		const html = renderToStaticMarkup(
			<RepoHeader name="acme/storefront" tabs={[]} current="hive" homeHref="#/" visibility="private" live="live" />,
		);
		const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? "";
		expect(visibleText(h1).trim()).toBe("acme/storefront");
		// Moving to the repo focuses its name.
		expect(html).toMatch(/<h1 tabindex="-1"/);
		expect(visibleText(html)).toContain("Private");
		expect(visibleText(html)).toContain("Live");
	});

	it("leaves the heading to a page that has its own", () => {
		const html = renderToStaticMarkup(
			<RepoHeader name="acme/storefront" tabs={[]} current="changes" homeHref="#/" heading={false} />,
		);
		expect(html).not.toContain("<h1");
		expect(visibleText(html)).toContain("acme/storefront");
	});

	it("puts its links in a ⋯ menu on a phone, and keeps its tabs under the top bar", () => {
		const links = [{ label: "View site", href: "/site/acme/storefront/", icon: "eye" as const, external: true }];
		const html = renderToStaticMarkup(
			<RepoHeader
				name="acme/storefront"
				tabs={[]}
				current="hive"
				homeHref="#/"
				aside={<a href="/x">x</a>}
				links={links}
			/>,
		);
		const menu = html.match(/<button[^>]*aria-label="More for acme\/storefront"[^>]*>/)?.[0] ?? "";
		expect(menu).toMatch(/\bhidden\b/);
		expect(menu).toMatch(/\bto-560:inline-flex\b/);
		expect(html).toMatch(/class="[^"]*\bsticky\b[^"]*\btop-\(--bar-height\)/);
		// No menu when there's nothing to put in it.
		expect(renderToStaticMarkup(<RepoHeader name="a/b" tabs={[]} current="hive" homeHref="#/" />)).not.toContain(
			"More for",
		);
	});
});

describe("a repo's page", () => {
	const page = (props: Partial<Parameters<typeof RepoPage>[0]>) =>
		renderToStaticMarkup(
			<RepoPage
				repo="acme/docs-site"
				view={{ kind: "repo", tab: "hive" }}
				snapshot={repoSnapshot}
				api={stubApi()}
				{...props}
			/>,
		);

	it("sits in the main landmark, header and tabs too, so the skip link reaches the tabs", () => {
		const html = page({});
		expect(html.indexOf('<main id="main"')).toBe(0);
		expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="acme/docs-site sections"'));
	});

	it("shows its header and tabs from the address while it loads", () => {
		const html = page({ snapshot: null, loading: true });
		const text = visibleText(html);
		expect(html).toMatch(/<h1[^>]*>.*acme\/docs-site.*<\/h1>/s);
		expect(text).toContain("Loading acme/docs-site…");
		expect(text).toContain("Changes");
		expect(text).not.toContain("hasn't started");
		expect(html).not.toContain('aria-disabled="true"');
	});

	it("dims the tabs GitHive can't show before it starts on the repo, and shows no live dot", () => {
		const html = page({ snapshot: null, liveStatus: "live" });
		const dimmed = [...html.matchAll(/aria-disabled="true"[^>]*>(.*?)<span class="sr-only">/gs)].map((match) =>
			visibleText(match[1]!).trim(),
		);
		expect(dimmed).toEqual(["Changes", "Claims", "Agents", "Audit"]);
		expect(html).toContain(NOT_STARTED_TAB);
		expect(visibleText(html)).not.toMatch(/\bLive\b/);
		expect(html).toContain('href="#/repos/acme/docs-site/settings"');
		expect(html).not.toContain('href="#/repos/acme/docs-site/claims"');
	});

	it("names its tabs in order: the keys 1 to 8 choose them", () => {
		expect(repoTabs("a/b", repoSnapshot).map((tab) => tab.id)).toEqual([
			"hive",
			"changes",
			"history",
			"claims",
			"code",
			"agents",
			"audit",
			"settings",
		]);
	});
});

describe("tabs", () => {
	it("mark the current one, and make one with nothing yet no link, saying why", () => {
		const html = renderToStaticMarkup(
			<Tabs
				label="Sections"
				current="a"
				items={[
					{ id: "a", label: "A", href: "#/a" },
					{ id: "b", label: "B", href: "#/b", unavailable: "Not yet" },
				]}
			/>,
		);
		expect(html).toMatch(/<a href="#\/a"[^>]*aria-current="page"/);
		expect(html).not.toContain('href="#/b"');
		expect(html).toMatch(/role="link" aria-disabled="true" tabindex="0"/);
		expect(html).toMatch(/class="sr-only">, Not yet</);
	});
});
