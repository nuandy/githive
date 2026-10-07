import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeView } from "./CodeBrowser";

const tree = { ref: "master", commit: "abc1234def", files: ["README.md", "src/index.ts", "src/stats/page.tsx", "assets/logo.png"], truncated: false };
const base = { repo: "my-app", branch: "master", tree };

describe("the Code tab", () => {
	it("lists a folder, folders first, with links into each", () => {
		const html = renderToStaticMarkup(<CodeView {...base} path="" />);
		expect(html).toContain(">master<");
		const order = ["assets", "src", "README.md"].map((name) => html.indexOf(`<span>${name}</span>`));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(html).toContain('href="#/repos/my-app/code/src"');
		const sub = renderToStaticMarkup(<CodeView {...base} path="src" />);
		expect(sub).toContain('href="#/repos/my-app/code/src/stats"');
		expect(sub).toContain("<span>..</span>");
	});

	it("shows a file with line numbers and the path as crumbs", () => {
		const html = renderToStaticMarkup(<CodeView {...base} path="src/stats/page.tsx" file={{ ref: "master", commit: "abc", path: "src/stats/page.tsx", size: 24, text: "const a = 1;\nexport { a };\n" }} />);
		expect(html).toMatch(/<a href="#\/repos\/my-app\/code">my-app<\/a>.*<a href="#\/repos\/my-app\/code\/src">src<\/a>.*<a href="#\/repos\/my-app\/code\/src\/stats">stats<\/a>.*<strong aria-current="page">page\.tsx<\/strong>/);
		expect(html).toContain("2 lines");
		expect(html).toMatch(/<td class="code__no" aria-hidden="true">1<\/td><td class="code__text">const a = 1;<\/td>/);
		expect(html).toMatch(/<td class="code__no" aria-hidden="true">2<\/td>/);
		expect(html).not.toMatch(/aria-hidden="true">3</);
	});

	it("says when a file is binary or too big, or the path isn't there", () => {
		expect(renderToStaticMarkup(<CodeView {...base} path="assets/logo.png" file={{ ref: "master", commit: "abc", path: "assets/logo.png", size: 2048, binary: true }} />)).toContain("binary file");
		expect(renderToStaticMarkup(<CodeView {...base} path="README.md" file={{ ref: "master", commit: "abc", path: "README.md", size: 9_000_000, tooBig: true }} />)).toContain("too big to show");
		expect(renderToStaticMarkup(<CodeView {...base} path="nope.ts" />)).toContain("Nothing at this path");
	});

	it("browses another commit when the address names one, with a way back", () => {
		const html = renderToStaticMarkup(<CodeView {...base} path="" refParam="ffee00112233" />);
		expect(html).toContain("ffee001");
		expect(html).toContain('href="#/repos/my-app/code/src?ref=ffee00112233"');
		expect(html).toContain("Back to master");
	});

	it("says when the listing is cut short, and shows loading and errors", () => {
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={{ ...tree, truncated: true }} />)).toContain("only part of its file list is shown");
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={undefined} />)).toContain("Loading files");
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={undefined} treeError="no repo my-app" />)).toContain("no repo my-app");
	});
});
