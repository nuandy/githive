import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { holdersFromTask } from "../lib/claimsMap";
import { ago, makeChange, makeTask } from "../test/fixtures";
import { ClaimsMap } from "./ClaimsMap";

const task = makeTask({
	slices: [
		makeChange({ id: "stats", title: "Stats page", owns: ["src/stats/"], touched: ["src/stats/new.ts"], openedBy: "agent:agent-a" }),
		makeChange({ id: "readme", title: "README", owns: ["README.md"], openedBy: "agent:agent-b" }),
	],
	checks: [{ pair: ["readme", "stats"], heads: ["a", "b"], status: "conflict", files: ["README.md"], checkedAt: ago(1) }],
});
const holders = holdersFromTask(task, "my-app");
const tree = { ref: "master", commit: "abc", files: ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx"], truncated: false };

describe("the Claims map", () => {
	it("shows a legend of open changes with their agent, color and conflicts", () => {
		const html = renderToStaticMarkup(<ClaimsMap branch="master" holders={holders} tree={tree} />);
		expect(html).toMatch(/claims__swatch claim-c0.*Stats page.*agent-a/);
		expect(html).toMatch(/claim-c1.*README.*agent-b/);
		expect(html).toContain("conflicts in 1 file");
		expect(html).toContain("Files on master");
	});

	it("colors claimed files and folders, links them to their change, and marks conflicts", () => {
		const html = renderToStaticMarkup(<ClaimsMap branch="master" holders={holders} tree={tree} />);
		expect(html).toMatch(/<a href="#\/repos\/my-app\/changes\/readme" class="claims__item claims__item--held claim-c1"[^>]*>.*README\.md.*aria-label="conflict"/);
		expect(html).toMatch(/<summary class="claims__item claims__dir claims__item--held claim-c0"[^>]*>.*stats/);
		expect(html).toMatch(/<a href="#\/repos\/my-app\/changes\/stats" class="claims__item claims__item--held claim-c0"[^>]*>.*page\.tsx/);
		expect(html).toMatch(/<span class="claims__item">.*index\.ts/);
		// A folder with claims inside opens; one without stays folded unless it is small at the top.
		expect(html).toMatch(/<details open="">.*src/);
	});

	it("lists claimed paths that aren't on the branch yet, and says when the listing is cut short", () => {
		const html = renderToStaticMarkup(<ClaimsMap branch="master" holders={holders} tree={{ ...tree, truncated: true }} />);
		expect(html).toContain("Claimed, not on master yet");
		expect(html).toContain("src/stats/new.ts");
		expect(html).toContain("only part of its file list is shown");
	});

	it("handles no claims, loading and errors", () => {
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={[]} tree={tree} />)).toContain("every path is free");
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} />)).toContain("Loading files");
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} treeError="the repo has no commits" />)).toContain("the repo has no commits");
	});
});
