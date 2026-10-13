import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleText } from "../test/fixtures";
import { CodeView } from "./CodeBrowser";

const tree = {
	ref: "master",
	commit: "abc1234def",
	files: ["README.md", "src/index.ts", "src/stats/page.tsx", "assets/logo.png"],
	truncated: false,
};
const base = { repo: "acme/my-app", branch: "master", tree };

describe("the Code tab", () => {
	it("lists a folder, folders first, with links into each", () => {
		const html = renderToStaticMarkup(<CodeView {...base} path="" />);
		expect(html).toContain(">master<");
		const order = ["assets", "src", "README.md"].map((name) => html.indexOf(`<span>${name}</span>`));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(html).toContain('href="#/repos/acme/my-app/code/src"');
		const sub = renderToStaticMarkup(<CodeView {...base} path="src" />);
		expect(sub).toContain('href="#/repos/acme/my-app/code/src/stats"');
		expect(sub).toContain("<span>..</span>");
	});

	it("shows a file with line numbers and the path as crumbs", () => {
		const html = renderToStaticMarkup(
			<CodeView
				{...base}
				path="src/stats/page.tsx"
				file={{
					ref: "master",
					commit: "abc",
					path: "src/stats/page.tsx",
					size: 24,
					text: "const a = 1;\nexport { a };\n",
				}}
			/>,
		);
		expect(html).toMatch(
			new RegExp(
				'<a href="#/repos/acme/my-app/code">my-app</a>.*' +
					'<a href="#/repos/acme/my-app/code/src">src</a>.*' +
					'<a href="#/repos/acme/my-app/code/src/stats">stats</a>.*' +
					'<strong aria-current="page">page\\.tsx</strong>',
			),
		);
		expect(html).toContain("2 lines");
		expect(html).toMatch(/<td class="[^"]*" aria-hidden="true">1<\/td><td class="[^"]*">const a = 1;<\/td>/);
		expect(html).toMatch(/<td class="[^"]*" aria-hidden="true">2<\/td>/);
		expect(html).not.toMatch(/aria-hidden="true">3</);
	});

	it("says when a file is binary or too big, or the path isn't there", () => {
		expect(
			renderToStaticMarkup(
				<CodeView
					{...base}
					path="assets/logo.png"
					file={{ ref: "master", commit: "abc", path: "assets/logo.png", size: 2048, binary: true }}
				/>,
			),
		).toContain("binary file");
		expect(
			renderToStaticMarkup(
				<CodeView
					{...base}
					path="README.md"
					file={{ ref: "master", commit: "abc", path: "README.md", size: 9_000_000, tooBig: true }}
				/>,
			),
		).toContain("too big to show");
		expect(renderToStaticMarkup(<CodeView {...base} path="nope.ts" />)).toContain("Nothing at this path");
	});

	it("browses another commit when the address names one, with a way back", () => {
		const html = renderToStaticMarkup(<CodeView {...base} path="" refParam="ffee00112233" />);
		expect(html).toContain("ffee001");
		expect(html).toContain('href="#/repos/acme/my-app/code/src?ref=ffee00112233"');
		expect(html).toContain("Back to master");
	});

	it("says when the listing is cut short, and shows loading and errors", () => {
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={{ ...tree, truncated: true }} />)).toContain(
			"only part of its file list is shown",
		);
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={undefined} />)).toContain("Loading files");
		expect(renderToStaticMarkup(<CodeView {...base} path="" tree={undefined} treeError="no repo my-app" />)).toContain(
			"no repo my-app",
		);
	});

	it("formats a Markdown file, with its source a click away", () => {
		const readme = {
			ref: "master",
			commit: "abc",
			path: "README.md",
			size: 60,
			text: "# My app\n\nSee [the stats](src/stats/page.tsx).\n",
		};
		const html = renderToStaticMarkup(<CodeView {...base} path="README.md" file={readme} />);
		expect(html).toMatch(/<h1 class="[^"]*">My app<\/h1>/);
		expect(html).toContain('<a href="#/repos/acme/my-app/code/src/stats/page.tsx">the stats</a>');
		expect(html).toMatch(
			/<button[^>]*aria-pressed="true"[^>]*>Formatted<\/button><button[^>]*aria-pressed="false"[^>]*>Source/,
		);
		expect(html).not.toContain("<table");
		const source = renderToStaticMarkup(<CodeView {...base} path="README.md" file={readme} source />);
		expect(source).toMatch(/aria-hidden="true">1<\/td><td class="[^"]*"># My app<\/td>/);
		expect(source).not.toContain("<h1");
	});

	it("says who holds a file, and the last change to touch it", () => {
		const html = renderToStaticMarkup(
			<CodeView
				{...base}
				path="src/index.ts"
				holder={{
					change: "coupons",
					title: "Let shoppers apply a coupon code in the cart drawer, and keep it across reloads.",
					agent: "mara/claude",
					paths: ["src/"],
					href: "#/repos/acme/my-app/changes/coupons",
					state: "in-review",
					conflicts: [],
				}}
				lastChange={{
					commit: "c0ffee1234",
					change: "prices",
					agent: "devon/codex",
					head: "h",
					title: "Format prices",
					files: ["src/index.ts"],
					reviews: [],
				}}
			/>,
		);
		const text = visibleText(html);
		expect(text).toContain(
			"src/index.ts is claimed by mara/claude for “ Let shoppers apply a coupon code in the cart drawer, and… ”, in review.",
		);
		expect(html).toContain('<a href="#/repos/acme/my-app/changes/coupons">');
		expect(html).toMatch(/<span data-state="in-review"/);
		expect(text).toContain("Last changed by Format prices · c0ffee1");
		expect(html).toContain('<a href="#/repos/acme/my-app/changes/prices">Format prices</a>');
	});

	it("switches branches from a menu where there's more than one", () => {
		const one = renderToStaticMarkup(<CodeView {...base} path="" />);
		expect(one).not.toContain('aria-label="Branch: master"');
		const many = renderToStaticMarkup(<CodeView {...base} path="src" branches={["release/2.4"]} />);
		expect(many).toMatch(
			/<button[^>]*aria-label="Branch: master"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="Branch: master"/,
		);
		const atCommit = renderToStaticMarkup(
			<CodeView {...base} path="src" refParam="ffee00112233" branches={["release/2.4"]} />,
		);
		expect(atCommit).toContain('aria-label="Branch: ffee001"');
	});
});
