import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRepoRows } from "../lib/repos";
import { ago } from "../test/fixtures";
import { RepoList } from "./RepoList";

describe("the Repositories page", () => {
	it("lists repos with their counts and what needs you", () => {
		const rows = buildRepoRows({
			repos: [
				{ repo: "my-app", since: ago(10), summary: { open: 3, needsYou: 1, countedAt: ago(1) } },
				{ repo: "docs-site", since: ago(1), summary: { open: 1, countedAt: ago(1) } },
			],
		});
		const html = renderToStaticMarkup(<RepoList rows={rows} loaded />);
		expect(html).toContain('href="#/repos/my-app"');
		expect(html).toContain('href="#/repos/docs-site"');
		expect(html).toContain("3 open");
		expect(html).toContain("1 needs you");
		expect(html).toContain("1 open");
		expect(html).toContain("Find a repository");
		expect(html).not.toMatch(/elected/);
	});

	it("explains how agents start a repo when nothing is open", () => {
		const html = renderToStaticMarkup(<RepoList rows={[]} loaded />);
		expect(html).toContain("No repos are open for agents yet");
		expect(html).toContain("start");
	});
});
