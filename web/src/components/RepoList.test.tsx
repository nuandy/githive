import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRepoRows } from "../lib/repos";
import { ago } from "../test/fixtures";
import { OpenRepoForm } from "./OpenRepoForm";
import { RepoList } from "./RepoList";

const noop = () => undefined;

describe("the Repositories page", () => {
	it("lists repos in both modes with their counts and a mode badge", () => {
		const rows = buildRepoRows({
			tasks: [{ id: "open-my-app", repo: "my-app", createdAt: ago(10), elected: true, summary: { open: 3, needsYou: 1, countedAt: ago(1) } }],
			free: [{ repo: "docs-site", since: ago(1), summary: { open: 1, countedAt: ago(1) } }],
		});
		const html = renderToStaticMarkup(<RepoList rows={rows} loaded allRepos={[]} opening={false} onOpenRepo={noop} />);
		expect(html).toContain('href="#/repos/my-app"');
		expect(html).toContain('href="#/free/docs-site"');
		expect(html).toContain("3 open");
		expect(html).toContain("1 needs you");
		expect(html).toContain("1 open");
		expect(html).toMatch(/>elected</);
		expect(html).toMatch(/>coordinator-free</);
		expect(html).toContain("Find a repository");
		expect(html).toContain("Open a repo");
	});

	it("explains how agents join when nothing is open", () => {
		const html = renderToStaticMarkup(<RepoList rows={[]} loaded allRepos={[]} opening={false} onOpenRepo={noop} />);
		expect(html).toContain("No repos are open for agents yet");
		expect(html).toContain("join_repo");
		expect(html).toContain("Open a repo");
	});

	it("offers an Open a repo form with the account's repos", () => {
		const html = renderToStaticMarkup(<OpenRepoForm repos={[{ name: "example" }]} opening={false} onOpen={noop} onCancel={noop} />);
		expect(html).toContain("Open a repo");
		expect(html).toContain("Open for agents");
		expect(html).toContain('<option value="example">');
		expect(html).toContain("join_repo");
		expect(renderToStaticMarkup(<OpenRepoForm repos={[]} opening onOpen={noop} error="no repo example" />)).toMatch(/Opening…[\s\S]*|no repo example/);
	});
});
