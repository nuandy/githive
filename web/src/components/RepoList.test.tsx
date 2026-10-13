import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRepoRows } from "../lib/repos";
import { ago, visibleText } from "../test/fixtures";
import { RepoList } from "./RepoList";

describe("the Repositories page", () => {
	it("lists repos with their counts and what needs you", () => {
		const rows = buildRepoRows({
			repos: [
				{ repo: "acme/my-app", since: ago(10), summary: { open: 3, needsYou: 1, countedAt: ago(1) } },
				{ repo: "acme/docs-site", since: ago(1), summary: { open: 1, countedAt: ago(1) } },
			],
		});
		const html = renderToStaticMarkup(<RepoList rows={rows} loaded />);
		expect(html).toContain('href="#/repos/acme/my-app"');
		expect(html).toContain('href="#/repos/acme/docs-site"');
		expect(html).toContain("3 open");
		expect(html).toContain("1 change needs you");
		// What needs a person comes first.
		expect(html.indexOf("Needs you")).toBeLessThan(html.indexOf("At work"));
		expect(html.indexOf("acme/</span>my-app")).toBeLessThan(html.indexOf("acme/</span>docs-site"));
		expect(html).toContain("1 open");
		expect(html).toContain("Find a repository");
		expect(html).not.toMatch(/elected/);
	});

	it("lists other people's public repos apart, under Public, after the reader's own", () => {
		const rows = buildRepoRows({
			repos: [
				{ repo: "ada/mine", since: ago(5), summary: { open: 1, countedAt: ago(1) } },
				{ repo: "bob/shared-demo", since: ago(1), summary: { open: 2, countedAt: ago(1) }, public: true },
			],
		});
		const text = visibleText(renderToStaticMarkup(<RepoList rows={rows} loaded />));
		expect(text.indexOf("ada/ mine")).toBeGreaterThan(-1);
		expect(text.indexOf("ada/ mine")).toBeLessThan(text.indexOf("Public 1"));
		expect(text.indexOf("Public 1")).toBeLessThan(text.indexOf("bob/ shared-demo"));
		// Its work isn't counted as the reader's own.
		expect(text).toContain("1 repository 1 open change");
	});

	it("says a repo's work all landed, how much and when, once its last stretch finishes", () => {
		const lastStretch = { landed: 200, failed: 0, agents: 200, from: ago(37), to: ago(5) };
		const rows = buildRepoRows({
			repos: [{ repo: "acme/web", since: ago(60), summary: { open: 0, merged: 200, lastStretch, countedAt: ago(1) } }],
		});
		const text = visibleText(renderToStaticMarkup(<RepoList rows={rows} loaded />));
		expect(text).toContain("Just finished");
		expect(text).toContain("✓ All landed");
		expect(text).toContain("200 changes in 32 minutes, by 200 agents");
		expect(text).toContain("Finished 5 minutes ago");
	});

	it("explains what agents do in a repo when there's none, and offers to make one", () => {
		const html = renderToStaticMarkup(<RepoList rows={[]} loaded canCreate />);
		expect(html).toContain("No repositories yet");
		expect(html).toContain("GitHive starts on it at once");
		// Once, in the page's header: the empty state doesn't offer it again.
		expect(html.match(/href="#\/new"/g)).toHaveLength(1);
		expect(html).toContain("Create an organization");
	});

	it("shows each repo's owner, and offers making only to people signed in", () => {
		const row = { name: "acme/web", open: 0, needsYou: 0, merged: 0, violations: 0, detailed: false };
		const html = renderToStaticMarkup(<RepoList rows={[row]} loaded />);
		expect(html).toMatch(/<a [^>]*href="#\/repos\/acme\/web"><span [^>]*>acme\/<\/span>web<\/a>/);
		expect(html).not.toContain("New repository");
	});
});
