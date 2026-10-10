import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { ago, repoSnapshot } from "../test/fixtures";
import { ClaimsMap } from "./ClaimsMap";

const claim = (change: string, intent: string, agent: string, paths: string[]): RepoSnapshot["claims"][number] => ({
	change,
	agent,
	paths,
	intent,
	since: ago(30),
	active: ago(5),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
});
const snapshot = {
	...repoSnapshot,
	claims: [
		claim("stats", "Stats page", "agent-a", ["src/stats/", "src/stats/new.ts"]),
		claim("readme", "README", "agent-b", ["README.md"]),
	],
};
// A conflict, where the server reports one, shows on the holder's paths.
const holders = holdersFromSnapshot(snapshot, "acme/my-app").map((h) =>
	h.change === "readme" ? { ...h, conflicts: ["README.md"] } : h,
);
const tree = {
	ref: "master",
	commit: "abc",
	files: ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx"],
	truncated: false,
};

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
		expect(html).toMatch(
			new RegExp(
				'<a href="#/repos/acme/my-app/changes/readme" class="claims__item claims__item--held claim-c1"[^>]*>' +
					'.*README\\.md.*aria-label="conflict"',
			),
		);
		expect(html).toMatch(/<summary class="claims__item claims__dir claims__item--held claim-c0"[^>]*>.*stats/);
		expect(html).toMatch(
			/<a href="#\/repos\/acme\/my-app\/changes\/stats" class="claims__item claims__item--held claim-c0"[^>]*>.*page\.tsx/,
		);
		expect(html).toMatch(/<span class="claims__item">.*index\.ts/);
		// A folder with claims inside opens; one without stays folded unless it is small at the top.
		expect(html).toMatch(/<details open="">.*src/);
	});

	it("lists claimed paths that aren't on the branch yet, and says when the listing is cut short", () => {
		const html = renderToStaticMarkup(
			<ClaimsMap branch="master" holders={holders} tree={{ ...tree, truncated: true }} />,
		);
		expect(html).toContain("Claimed, not on master yet");
		expect(html).toContain("src/stats/new.ts");
		expect(html).toContain("only part of its file list is shown");
	});

	it("handles no claims, loading and errors", () => {
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={[]} tree={tree} />)).toContain("every path is free");
		expect(renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} />)).toContain("Loading files");
		expect(
			renderToStaticMarkup(<ClaimsMap branch="main" holders={holders} treeError="the repo has no commits" />),
		).toContain("the repo has no commits");
	});
});
