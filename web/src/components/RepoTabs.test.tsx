import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { historyFixture, repoSnapshot as snapshot, stubApi } from "../test/fixtures";
import { AuditTab, ChangeList, ChangePage, SettingsTab } from "./RepoTabs";
import { RepoPage } from "./RepoPage";

// A repo, shown like any other: its claims as open changes, the audit with what's
// still open and what a revert resolved, and the conventions agents follow.

describe("a repo", () => {
	it("shows claims in force as open changes, with head and approvals", () => {
		const html = renderToStaticMarkup(<ChangeList snapshot={snapshot} repo="acme/docs-site" />);
		expect(html).toContain("Rewrite the C section");
		expect(html).toContain('href="#/repos/acme/docs-site/changes/c-1"');
		expect(html).toContain("src/c/");
		expect(html).toContain("by agent-c");
		expect(html).toContain("1/2 approvals");
		expect(html).toContain("b1c2d3e");
		expect(html).toContain("Changes requested");
		expect(html).toMatch(/3<\/span> merged on main/);
	});

	it("shows the audit, with open and resolved violations apart, and recent reviews", () => {
		const html = renderToStaticMarkup(<AuditTab snapshot={snapshot} />);
		expect(html).toContain("1 open violation");
		expect(html).toContain("undeclared");
		expect(html).toMatch(/resolved by ee872a3/);
		expect(html).toContain("rev-1");
		expect(html).toContain("suite passes");
		expect(
			renderToStaticMarkup(<AuditTab snapshot={{ ...snapshot, audit: { merges: 1, open: 0, violations: [] } }} />),
		).toMatch(/No violations/);
	});

	it("shows the settings: approvals, vetoes, checks and signed records", () => {
		const html = renderToStaticMarkup(<SettingsTab snapshot={snapshot} />);
		expect(html).toMatch(/2 approvals/);
		expect(html).toContain("security can block");
		expect(html).toContain("npm test");
		expect(html).toMatch(/verified identity/);
		expect(html).toMatch(/own fork/);
	});

	it("says in the settings who can block a merge: the grants, or people and GitHive's reviewers", () => {
		const byDefault = renderToStaticMarkup(<SettingsTab snapshot={snapshot} />);
		expect(byDefault).toContain("<dt>Who can block</dt><dd>security: people, GitHive&#x27;s reviewers.");
		const granted = renderToStaticMarkup(
			<SettingsTab
				snapshot={{ ...snapshot, policy: { ...snapshot.policy, grants: { security: ["security-1", "person:*"] } } }}
			/>,
		);
		expect(granted).toContain("security: security-1, people.");
	});

	it("says in the header and settings how claims are kept, sharded or in one record", () => {
		const page = (sharding: typeof snapshot.sharding) =>
			renderToStaticMarkup(
				<RepoPage
					repo="acme/docs-site"
					view={{ kind: "repo", tab: "settings" }}
					snapshot={{ ...snapshot, sharding, shardDepth: sharding && typeof sharding === "object" ? 2 : undefined }}
					api={stubApi()}
				/>,
			);
		const flat = page("on demand");
		expect(flat).toMatch(/class="pill pill--outline mode-badge"[^>]*>One claims record/);
		expect(flat).toMatch(/<dt>Claims<\/dt><dd>Claims are kept in one record/);
		const sharded = page({ since: "2026-10-07T09:30:00.000Z", because: "8 agents hold claims" });
		expect(sharded).toMatch(/mode-badge mode-badge--sharded"[^>]*>Sharded claims/);
		expect(sharded).toContain("(8 agents hold claims)");
		const votes = renderToStaticMarkup(
			<RepoPage
				repo="acme/docs-site"
				view={{ kind: "repo", tab: "settings" }}
				snapshot={{
					...snapshot,
					sharding: "on demand",
					votesSharding: { since: "2026-10-07T09:30:00.000Z", because: "8 reviewers voting" },
				}}
				api={stubApi()}
			/>,
		);
		expect(votes).toMatch(/mode-badge--sharded"[^>]*>Sharded votes/);
		expect(votes).toMatch(/<dt>Votes<\/dt><dd>Votes are split by commit/);
		// Older servers don't say: no badge, no line.
		const older = page(undefined);
		expect(older).not.toMatch(/claims record|Sharded claims|<dt>Claims<\/dt>|<dt>Votes<\/dt>/);
	});

	it("shows one claim like a pull request, with its commits, votes and hosted agents", () => {
		const html = renderToStaticMarkup(
			<ChangePage
				snapshot={snapshot}
				changeId="c-1"
				claim={snapshot.claims[0]}
				history={historyFixture}
				repo="acme/docs-site"
				tab="conversation"
			/>,
		);
		expect(html).toMatch(/<strong>agent-c<\/strong> wants to merge <code[^>]*>changes\/c-1<\/code>/);
		expect(html).toContain("rev-1</strong> (tests reviewer) approved these changes");
		expect(html).toContain("First draft of section C");
		expect(html).toContain("1 of 2 approvals");
		expect(html).toMatch(/Builder working \(revision 1\)/);
		expect(html).toMatch(/security.*reject/);
		expect(html).toMatch(/Commits<\/span><span class="counter">2<\/span>/);
		// An agent's question for a person, and a person's vote form.
		const asked = {
			...snapshot.claims[0]!,
			attention: { reason: "reviewers disagree on the cache size", agent: "agent-c", at: "" },
		};
		const withQuestion = renderToStaticMarkup(
			<ChangePage
				snapshot={snapshot}
				changeId="c-1"
				claim={asked}
				history={historyFixture}
				repo="acme/docs-site"
				tab="conversation"
				api={{ vote: async () => ({}) }}
			/>,
		);
		expect(withQuestion).toContain("agent-c asks you");
		expect(withQuestion).toContain("reviewers disagree on the cache size");
		expect(withQuestion).toContain("Submit vote");
		expect(withQuestion).toMatch(/<option value="review"[^>]*>review reviewer<\/option>/);
		expect(withQuestion).toMatch(/<option value="security"[^>]*>security reviewer<\/option>/);
		const loading = renderToStaticMarkup(
			<ChangePage
				snapshot={snapshot}
				changeId="c-1"
				claim={{ ...snapshot.claims[0]!, head: null, hosted: undefined }}
				repo="acme/docs-site"
				tab="conversation"
			/>,
		);
		expect(loading).toContain("nothing pushed yet");
		expect(loading).toContain("Loading history");
	});

	it("has Changes, Audit and Settings tabs", () => {
		const html = renderToStaticMarkup(
			<RepoPage repo="acme/docs-site" view={{ kind: "repo", tab: "audit" }} snapshot={snapshot} api={stubApi()} />,
		);
		expect(html).toContain('href="#/repos/acme/docs-site/audit"');
		expect(html).toMatch(/aria-current="page"[^>]*>.*Audit/);
		for (const tab of ["Changes", "Settings"]) expect(html).toContain(`<span>${tab}</span>`);
	});
});
