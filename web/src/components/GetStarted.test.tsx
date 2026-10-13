import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { gettingStarted } from "../lib/gettingStarted";
import type { RepoRow } from "../lib/repos";
import { visibleText } from "../test/fixtures";
import { GetStartedView } from "./GetStarted";

const row = (name: string, more: Partial<RepoRow> = {}): RepoRow => ({
	name,
	open: 0,
	needsYou: 0,
	merged: 0,
	violations: 0,
	detailed: true,
	...more,
});
const view = (rows: RepoRow[]) =>
	renderToStaticMarkup(<GetStartedView start={gettingStarted(rows, [], [])} onDismiss={() => {}} />);

describe("Get started on Repositories", () => {
	it("shows a new account its four steps, the first one leading to the new repository form", () => {
		const html = view([]);
		const text = visibleText(html);
		expect(text).toContain("Get started");
		expect(text).toContain("0 of 4 done");
		for (const title of ["Make a repository", "Connect an agent", "Give it a task", "See it land"])
			expect(text).toContain(title);
		expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*>.*Make a repository.*href="#\/new"/s);
		// Nothing has landed: it can't be put away yet.
		expect(text).not.toContain("Dismiss");
	});

	it("leaves a step's way to the page when the page leads there already", () => {
		const html = renderToStaticMarkup(
			<GetStartedView start={gettingStarted([], [], [])} onDismiss={() => {}} elsewhere={["#/new"]} />,
		);
		expect(html).not.toContain('href="#/new"');
		expect(html).toContain('href="#/settings/agents"');
	});

	it("ticks what's done, saying so to a screen reader, and leads to the next step", () => {
		const html = view([row("robin/notes", { open: 1 })]);
		const text = visibleText(html);
		expect(text).toContain("2 of 4 done");
		expect(text).toContain("Make a repository (done)");
		expect(html).toMatch(/aria-current="step"[^>]*>.*Connect an agent.*href="#\/settings\/agents"/s);
	});

	it("can be put away once something has landed, and says so in a line when all four are done", () => {
		expect(visibleText(view([row("acme/site", { merged: 2 })]))).toContain("Dismiss");
	});
});
