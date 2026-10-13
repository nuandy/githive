import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { ago, repoSnapshot, visibleText } from "../test/fixtures";
import { ClaimsMap } from "./ClaimsMap";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, intent: string, agent: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent,
	paths,
	intent,
	since: ago(30),
	active: ago(5),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };
const snapshot = {
	...repoSnapshot,
	votes: [],
	claims: [
		claim("stats", "Stats page", "agent-a", ["src/stats/", "src/stats/new.ts"]),
		claim("readme", "README", "agent-b", ["README.md"], { head: "r1", approval: approved }),
	],
};
// A conflict, where the server reports one, shows on the holder's paths.
const holders = holdersFromSnapshot(snapshot, "acme/my-app").map((h) =>
	h.change === "readme" ? { ...h, conflicts: ["README.md"] } : h,
);
const tree = {
	ref: "master",
	commit: "abc",
	files: ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx", "src/stats/table.tsx"],
	truncated: false,
};

describe("the Claims map", () => {
	it("shows only what's claimed at first, each row in its change's state, named and linked to its change", () => {
		const html = renderToStaticMarkup(<ClaimsMap branch="master" holders={holders} tree={tree} />);
		expect(html).toContain("Who holds what on master");
		expect(html).toMatch(/<input type="checkbox" checked=""[^>]*\/>Only claimed/);
		// Unclaimed files aren't shown; the folders on the way to what's claimed are, opened.
		expect(html).not.toContain("guide.md");
		expect(html).not.toContain("index.ts");
		// Each claimed row: its state's mark and color, who holds it and for what, a link to its change.
		expect(html).toMatch(
			/<a href="#\/repos\/acme\/my-app\/changes\/readme" class="[^"]*--claim:var\(--good\)[^"]*"><span data-state="approved"[^>]*><span[^>]*>✓<\/span>.*README\.md.*aria-label="conflict".*agent-b · README<\/span><span class="sr-only">, approved, held by agent-b for README<\/span><\/a>/,
		);
		// A folder held whole: its row in its state, its holder linked beside it, and its files without saying so again.
		expect(html).toMatch(/<summary class="[^"]*--claim:var\(--stage-building\)[^"]*"><span data-state="building"/);
		expect(html).toMatch(
			/<a href="#\/repos\/acme\/my-app\/changes\/stats" class="absolute[^"]*">agent-a · Stats page<\/a>/,
		);
		expect(html).toMatch(
			/<a href="#\/repos\/acme\/my-app\/changes\/stats" class="[^"]*"><span data-state="building".*page\.tsx/,
		);
		const map = html.slice(0, html.indexOf("Claimed, not on master yet"));
		expect(map.match(/agent-a · Stats page/g)).toHaveLength(1);
		// What the marks mean, counted.
		expect(visibleText(html)).toContain("1 approved 1 building");
		expect(visibleText(html)).toContain("2 open changes hold 3 of 5 files");
	});

	it("shows every file when asked, an unclaimed one plain and folders counting what they hold", () => {
		const html = renderToStaticMarkup(<ClaimsMap branch="master" holders={holders} tree={tree} allFiles />);
		expect(html).toMatch(/<input type="checkbox"[^>]*\/>Only claimed/);
		expect(html).not.toMatch(/<input type="checkbox" checked=""/);
		// Unclaimed: a plain row, not a link, with room where a mark would be.
		expect(html).toMatch(
			/<li><span class="[^"]*"><span aria-hidden="true" class="[^"]*invisible[^"]*"><\/span><svg[^>]*>(?:(?!<\/svg>).)*<\/svg><span[^>]*>index\.ts<\/span>/,
		);
		expect(visibleText(html)).toMatch(/src 2 held/);
		expect(html).toMatch(/<details open="" class="disclosure">.*src/);
	});

	it("lists claimed paths that aren't on the branch yet, and says when the listing is cut short", () => {
		const html = renderToStaticMarkup(
			<ClaimsMap branch="master" holders={holders} tree={{ ...tree, truncated: true }} />,
		);
		expect(html).toContain("Claimed, not on master yet");
		expect(html).toMatch(/src\/stats\/new\.ts<\/span><span[^>]*>agent-a · Stats page/);
		expect(html).toContain("only part of its file list is shown");
	});

	it("says which other branches changes hold paths on", () => {
		const html = renderToStaticMarkup(
			<ClaimsMap
				branch="main"
				holders={holders}
				tree={tree}
				otherBranches={[{ branch: "release/2.4", count: 1, href: "#/repos/acme/my-app/changes?branch=release%2F2.4" }]}
			/>,
		);
		expect(visibleText(html)).toContain("1 open change lands on release/2.4 , and holds paths there, not here.");
		expect(html).toContain('href="#/repos/acme/my-app/changes?branch=release%2F2.4"');
	});

	it("handles no claims, loading and errors", () => {
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={[]} tree={tree} />)).toContain("every path is free");
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} />)).toContain("Loading files");
		expect(
			renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} treeError="the repo has no commits" />),
		).toContain("the repo has no commits");
	});
});
