import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BranchHistory } from "../api";
import { visibleText } from "../test/fixtures";
import { History, LandedFiles } from "./History";

// The History tab: what landed on the branch, why, and who approved it.

const landed: BranchHistory = {
	branch: "main",
	total: 3,
	changes: [
		{
			commit: "a".repeat(40),
			change: "login-limit",
			agent: "ada/builder",
			head: "h".repeat(40),
			title: "Rate-limit logins so guessing passwords is slow",
			intent: "Rate-limit logins so guessing passwords is slow",
			files: ["src/auth/login.ts", "test/login.test.ts"],
			reviews: [{ reviewer: "bob/reviewer", role: "security", verdict: "approve", evidence: "Ran the login tests" }],
			at: new Date().toISOString(),
		},
		{
			commit: "b".repeat(40),
			change: "typo-1",
			agent: "cy/fixer",
			head: "i".repeat(40),
			title: "Merge typo-1 by cy/fixer",
			files: ["README.md"],
			reviews: [],
		},
	],
};
const render = (history: BranchHistory | undefined, error?: string) =>
	visibleText(renderToStaticMarkup(<History repo="acme/web" history={history} error={error} />));

describe("the History tab", () => {
	it("lists each landed change with why it was made, who landed it, and each review's evidence", () => {
		const text = render(landed);
		expect(text).toContain("3 changes landed on main");
		expect(text).toContain("Rate-limit logins so guessing passwords is slow");
		expect(text).toContain("ada/builder landed login-limit");
		expect(text).toContain("2 files");
		expect(text).toContain("bob/reviewer (security) Ran the login tests");
		expect(text).toContain("Landed without review.");
		expect(text).toContain("And 1 earlier");
	});

	it("links each change to its page and its merge commit to the code at it", () => {
		const html = renderToStaticMarkup(<History repo="acme/web" history={landed} />);
		expect(html).toContain('href="#/repos/acme/web/changes/login-limit"');
		expect(html).toContain(`href="#/repos/acme/web/code?ref=${"a".repeat(40)}"`);
	});

	it("says when nothing has landed, while it loads, and when it couldn't load", () => {
		expect(render({ branch: "main", total: 0, changes: [] })).toContain("Nothing has landed on main yet");
		expect(render(undefined)).toContain("Loading history");
		expect(render(undefined, "offline")).toContain("history couldn t be loaded");
	});

	it("says why the history couldn't load, and offers to try again", () => {
		const text = visibleText(
			renderToStaticMarkup(
				<History repo="acme/docs" history={undefined} error="the server timed out" onRetry={() => undefined} />,
			),
		);
		expect(text).toContain("The history couldn t be loaded: the server timed out.");
		expect(text).toContain("Try again");
	});

	it("opens a change's files from its count, each linked to the code as it landed", () => {
		const html = renderToStaticMarkup(<History repo="acme/web" history={landed} />);
		expect(html).toMatch(/<button[^>]*aria-expanded="false" aria-controls="history-files-a+"[^>]*>2 files/);
		const files = renderToStaticMarkup(<LandedFiles repo="acme/web" landed={landed.changes[0]!} />);
		expect(files).toContain(`href="#/repos/acme/web/code/src/auth/login.ts?ref=${"a".repeat(40)}"`);
		expect(visibleText(files)).toContain("src/auth/login.ts test/login.test.ts");
	});

	it("counts all of a change's files, and says how many more there are than it lists", () => {
		const wide = { ...landed.changes[0]!, filesTotal: 26 };
		const html = renderToStaticMarkup(<History repo="acme/web" history={{ ...landed, changes: [wide] }} />);
		expect(html).toMatch(/aria-controls="history-files-a+"[^>]*>26 files/);
		const files = visibleText(renderToStaticMarkup(<LandedFiles repo="acme/web" landed={wide} />));
		expect(files).toContain("src/auth/login.ts test/login.test.ts and 24 more");
		expect(
			visibleText(renderToStaticMarkup(<LandedFiles repo="acme/web" landed={landed.changes[0]!} />)),
		).not.toContain("more");
	});

	it("puts the changes that landed together under one heading", () => {
		const at = landed.changes[0]!.at!;
		const batch = {
			...landed,
			changes: [landed.changes[0]!, { ...landed.changes[1]!, at }, { ...landed.changes[1]!, commit: "c".repeat(40) }],
		};
		const html = renderToStaticMarkup(<History repo="acme/web" history={batch} />);
		expect(visibleText(html)).toMatch(/Landed together at \d\d:\d\d · 2 changes Rate-limit logins/);
		expect(html.match(/Landed together/g)).toHaveLength(1);
		// A change on its own has no heading.
		expect(visibleText(renderToStaticMarkup(<History repo="acme/web" history={landed} />))).not.toContain(
			"Landed together",
		);
	});
});
