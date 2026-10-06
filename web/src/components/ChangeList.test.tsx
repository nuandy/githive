import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ago, approve, makeChange, makeTask } from "../test/fixtures";
import { ChangeList, sortChanges } from "./ChangeList";

const task = makeTask({
	slices: [
		makeChange({ id: "add-stats", title: "Add stats page", openedAt: ago(120), openedBy: "service:abc/agent-a", reviewHead: "h1", reviews: [approve("tests", "h1"), approve("security", "h1")], gate: { status: "passed", head: "h1", baseHead: "b", at: ago(1), excluded: [], result: { passed: true, head: "h1", baseHead: "b", results: [{ command: "npm test", exitCode: 0, output: "" }], at: ago(1) } } }),
		makeChange({ id: "fix-login", title: "Fix login redirect", owns: ["src/login/"], openedAt: ago(5), openedBy: "service:abc/agent-b", reviewHead: "h2" }),
		makeChange({ id: "rate-limit", title: "Rate limiter", owns: ["src/limit/"], openedAt: ago(60 * 24), openedBy: "blueprint-builder", attention: "Reviewers disagree" }),
		makeChange({ id: "old-1", title: "Old work", status: "integrated", endedAt: ago(300) }),
		makeChange({ id: "gone", title: "Given up", status: "abandoned", endedAt: ago(30) }),
	],
	checks: [{ pair: ["fix-login", "rate-limit"], heads: ["a", "b"], status: "conflict", files: ["src/shared.ts"], checkedAt: ago(2) }],
});

describe("the Changes tab", () => {
	it("shows open changes with GitHub-style filter counts, the one needing you first", () => {
		const html = renderToStaticMarkup(<ChangeList task={task} repo="my-app" base="repos" state="open" />);
		expect(html).toMatch(/<span class="change-list__count">3<\/span> Open/);
		expect(html).toMatch(/<span class="change-list__count">1<\/span> Merged/);
		expect(html).toMatch(/<span class="change-list__count">1<\/span> Abandoned/);
		expect(html).toMatch(/aria-current="page"[^>]*>.*Open/);
		const order = ["Rate limiter", "Fix login redirect", "Add stats page"].map((title) => html.indexOf(title));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(html).not.toContain("Old work");
		expect(html).toContain('href="#/repos/my-app/changes/add-stats"');
	});

	it("shows who opened each change, its reviews, checks and claim", () => {
		const html = renderToStaticMarkup(<ChangeList task={task} repo="my-app" base="repos" state="open" />);
		expect(html).toContain("by agent-a");
		expect(html).toContain("by Blueprint builder");
		expect(html).toContain("2/2 approvals");
		expect(html).toContain("0/2 approvals");
		expect(html).toContain("Needs you");
		expect(html).toContain("src/stats/");
		expect(html).toMatch(/>checks</);
	});

	it("warns on both sides of a conflict instead of showing a matrix", () => {
		const html = renderToStaticMarkup(<ChangeList task={task} repo="my-app" base="repos" state="open" />);
		expect(html).toContain("Conflicts with Rate limiter (rate-limit) in src/shared.ts");
		expect(html).toContain("Conflicts with Fix login redirect (fix-login) in src/shared.ts");
	});

	it("filters merged and abandoned changes", () => {
		const merged = renderToStaticMarkup(<ChangeList task={task} repo="my-app" base="repos" state="merged" />);
		expect(merged).toContain("Old work");
		expect(merged).not.toContain("Add stats page");
		expect(merged).toContain("merged 5 hours ago");
		const abandoned = renderToStaticMarkup(<ChangeList task={task} repo="my-app" base="repos" state="abandoned" />);
		expect(abandoned).toContain("Given up");
		expect(abandoned).toContain('href="#/repos/my-app?state=abandoned"');
	});

	it("explains how changes arrive when there are none", () => {
		const html = renderToStaticMarkup(<ChangeList task={makeTask()} repo="my-app" base="repos" state="open" />);
		expect(html).toContain("No open changes");
		expect(html).toContain("join_repo");
	});

	it("sorts ended changes by when they ended, newest first", () => {
		const a = makeChange({ id: "a", status: "integrated", endedAt: ago(10) });
		const b = makeChange({ id: "b", status: "integrated", endedAt: ago(1) });
		const c = makeChange({ id: "c", status: "integrated" });
		expect(sortChanges([a, b, c], "merged").map((x) => x.id)).toEqual(["b", "a", "c"]);
	});
});
