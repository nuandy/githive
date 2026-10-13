import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ago, historyFixture, repoSnapshot as snapshot, stubApi, visibleText } from "../test/fixtures";
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
		expect(html).toMatch(/3<\/span> landed on main/);
	});

	it("shows the audit, with open and resolved violations apart, and recent reviews", () => {
		const html = renderToStaticMarkup(<AuditTab repo="acme/docs-site" snapshot={snapshot} />);
		const text = visibleText(html);
		expect(html).toContain("1 open violation");
		// A rule in words, its id beside for whoever looks it up, and what to do about it while it's open.
		expect(html).toContain("<strong>Landed without GitHive&#x27;s records</strong>");
		expect(html).toContain('<code class="text-caption">undeclared</code>');
		expect(text).toMatch(/What to do: It names no change, claims or votes.*revert it/);
		// Each commit links to the code at it: the violation's and the one that resolved it.
		expect(html).toContain('in <a href="#/repos/acme/docs-site/code?ref=41664f1dcccc"><code>41664f1</code></a>');
		expect(html).toMatch(
			/Resolved by <a href="#\/repos\/acme\/docs-site\/code\?ref=ee872a30bbbb"><code>ee872a3<\/code><\/a>/,
		);
		expect(text).toContain("Changed a file another change holds");
		// A resolved violation says so in a badge, at full contrast, rather than fading, and needs nothing done.
		expect(html).toMatch(/data-slot="badge"[^>]*>Resolved</);
		expect(html).not.toMatch(/opacity-\d/);
		expect(text.match(/What to do/g)).toHaveLength(1);
		expect(html).toContain("rev-1");
		expect(html).toContain("suite passes");
		expect(
			renderToStaticMarkup(
				<AuditTab repo="acme/docs-site" snapshot={{ ...snapshot, audit: { merges: 1, open: 0, violations: [] } }} />,
			),
		).toMatch(/No violations/);
	});

	it("names the change a review was for, open or landed, and links its commit", () => {
		const html = renderToStaticMarkup(<AuditTab repo="acme/docs-site" snapshot={snapshot} />);
		expect(html).toContain(
			'approved <a href="#/repos/acme/docs-site/changes/c-1">Rewrite the C section</a> at <a href="#/repos/acme/docs-site/code?ref=b1c2d3e4f5a6"><code>b1c2d3e</code></a>',
		);
		const landed = renderToStaticMarkup(
			<AuditTab
				repo="acme/docs-site"
				snapshot={{ ...snapshot, claims: [] }}
				landed={[{ change: "c-0", title: "Write section B", head: "b1c2d3e4f5a6" }]}
			/>,
		);
		expect(landed).toContain('approved <a href="#/repos/acme/docs-site/changes/c-0">Write section B</a> at');
		// A commit no change names: its hash alone, linked.
		const unknown = renderToStaticMarkup(<AuditTab repo="acme/docs-site" snapshot={{ ...snapshot, claims: [] }} />);
		expect(unknown).toContain(
			'approved <a href="#/repos/acme/docs-site/code?ref=b1c2d3e4f5a6"><code>b1c2d3e</code></a>',
		);
	});

	it("stops replaying once the audit fails, and says why", () => {
		const text = visibleText(
			renderToStaticMarkup(
				<AuditTab
					repo="acme/docs-site"
					snapshot={{ ...snapshot, audit: undefined }}
					error="the records couldn't be read"
					onRetry={() => undefined}
				/>,
			),
		);
		expect(text).not.toContain("Replaying");
		expect(text).toContain("The audit couldn t be loaded: the records couldn t be read.");
		expect(text).toContain("Try again");
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
		// One record is a quiet outline; sharded stands out in the link's blue.
		expect(flat).toMatch(/class="[^"]*\btext-muted-foreground\b[^"]*"[^>]*>One claims record/);
		expect(flat).not.toMatch(/class="[^"]*\btext-link\b[^"]*"[^>]*>One claims record/);
		expect(flat).toMatch(/<dt>Claims<\/dt><dd>Claims are kept in one record/);
		const sharded = page({ since: "2026-10-07T09:30:00.000Z", because: "8 agents hold claims" });
		expect(sharded).toMatch(/class="[^"]*\btext-link\b[^"]*"[^>]*>Sharded claims/);
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
		expect(votes).toMatch(/class="[^"]*\btext-link\b[^"]*"[^>]*>Sharded votes/);
		expect(votes).toMatch(/<dt>Votes<\/dt><dd>Votes are split by commit/);
		// Older servers don't say: no badge, no line.
		const older = page(undefined);
		expect(older).not.toMatch(/claims record|Sharded claims|<dt>Claims<\/dt>|<dt>Votes<\/dt>/);
	});

	it("says when a claim frees up if its agent goes quiet, where it does at a time", () => {
		const at = (hour: number, minute: number) => new Date(2026, 9, 11, hour, minute).toISOString();
		const now = Date.parse(at(14, 0));
		const claim = snapshot.claims[0]!;
		const claims = [
			{ ...claim, change: "c-1", since: at(9, 0), lease: { waitingOn: "agent" as const, freeAfter: at(14, 30) } },
			{ ...claim, change: "c-2", since: at(10, 0), lease: { waitingOn: "agent" as const, freeAfter: at(13, 45) } },
			{ ...claim, change: "c-3", since: at(11, 0), lease: { waitingOn: "reviewers" as const } },
		];
		const html = renderToStaticMarkup(
			<ChangeList snapshot={{ ...snapshot, claims }} repo="acme/docs-site" now={now} />,
		);
		const rows = html.split("<li ").slice(1);
		// Each as soon as the others (all in review, active as long ago), so in the order of their ids.
		expect(rows.map((row) => row.match(/<span class="font-mono text-caption">([^<]+)<\/span>/)?.[1])).toEqual([
			"c-1",
			"c-2",
			"c-3",
		]);
		expect(rows[0]).toMatch(
			/class="(?![^"]*\btext-warn\b)[^"]*" title="Free after 14:30 if its agent does nothing more\. Claiming again renews it\."> · <svg[^>]*>.*<\/svg>free after 14:30<\/span>/,
		);
		// Past its time, anyone may take it: said in the warning tone.
		expect(rows[1]).toMatch(/class="[^"]*\btext-warn\b[^"]*"[^>]*> · <svg[^>]*>.*<\/svg>free since 13:45<\/span>/);
		// Waiting on review, it never frees: the list says nothing, the change's page says why.
		expect(rows[2]).not.toMatch(/[Ff]ree (after|since)/);
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
		expect(html).toMatch(/<strong>agent-c<\/strong> wants to land <code[^>]*>changes\/c-1<\/code> on <code/);
		expect(html).toContain("rev-1</strong> (tests reviewer) approved these changes");
		expect(html).toContain("First draft of section C");
		expect(html).toContain("1 of 2 approvals");
		expect(html).toMatch(/Builder working \(revision 1\)/);
		expect(html).toMatch(/security.*reject/);
		expect(html).toMatch(/Commits<\/span><span data-slot="counter"[^>]*>2<\/span>/);
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
		expect(withQuestion).toMatch(/<option value="review"[^>]*>reviewer<\/option>/);
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

describe("the Changes list", () => {
	type Claim = (typeof snapshot.claims)[number];
	const make = (change: string, over: Partial<Claim> = {}): Claim => ({
		...snapshot.claims[0]!,
		change,
		agent: `agent-${change}`,
		paths: [`src/${change}/`],
		intent: `Do ${change}`,
		hosted: undefined,
		approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
		head: `${change}-head`,
		...over,
	});
	const claims = [
		make("review", { active: ago(3) }),
		make("asks", { attention: { reason: "which cache?", agent: "agent-asks", at: ago(1) } }),
		make("ready", { approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } }),
		make("backport", { into: "release/2.4" }),
	];
	const repo = { ...snapshot, branch: "main", claims, votes: [] };

	it("leads with filter chips that count, and lists what needs action first", () => {
		const html = renderToStaticMarkup(<ChangeList snapshot={repo} repo="acme/web" shown="main" />);
		const chips = visibleText(/<nav aria-label="Show changes"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "");
		expect(chips).toBe(" Needs you 1 In review 1 Approved 1 Building 0 Landing 0 All 3 ");
		expect(html).toContain('href="#/repos/acme/web/changes?filter=needs-you"');
		// All is the list as it is, and the one shown.
		expect(html).toMatch(/<a href="#\/repos\/acme\/web\/changes" aria-current="true"[^>]*>All/);
		const titles = [...html.matchAll(/text-body font-semibold[^>]*>([^<]+)</g)].map((match) => match[1]);
		expect(titles).toEqual(["Do asks", "Do ready", "Do review"]);
		expect(visibleText(html)).toContain("active 3m ago");
		// What's landed links to the History tab.
		expect(html).toMatch(/<a href="#\/repos\/acme\/web\/history"[^>]*>.*3<\/span> landed on main<\/a>/);
		// The audit's open violations, as needsYou counts them, lead to the Audit tab.
		expect(visibleText(html)).toContain("1 merge for the audit to look at");
		expect(html).toContain('<p data-slot="announcer"');
	});

	it("narrows to a filter, keeps the branch in its chips' links, and searches", () => {
		const needs = renderToStaticMarkup(<ChangeList snapshot={repo} repo="acme/web" shown="main" filter="needs-you" />);
		expect([...needs.matchAll(/text-body font-semibold[^>]*>([^<]+)</g)].map((match) => match[1])).toEqual(["Do asks"]);
		const release = renderToStaticMarkup(
			<ChangeList snapshot={repo} repo="acme/web" shown="release/2.4" filter="approved" />,
		);
		expect(release).toContain('href="#/repos/acme/web/changes?branch=release%2F2.4&amp;filter=needs-you"');
		expect(visibleText(release)).toContain("No change is approved on release/2.4. Show all 1");
		const found = renderToStaticMarkup(<ChangeList snapshot={repo} repo="acme/web" shown="main" search="src/ready" />);
		expect([...found.matchAll(/text-body font-semibold[^>]*>([^<]+)</g)].map((match) => match[1])).toEqual([
			"Do ready",
		]);
		const none = renderToStaticMarkup(
			<ChangeList snapshot={repo} repo="acme/web" shown="main" filter="needs-you" search="zzz" />,
		);
		expect(visibleText(none)).toContain("No change on main matches “zzz” under Needs you. Show all 0 Clear the search");
	});

	it("counts the shown branch's open changes on its tab", () => {
		const tab = (view: Parameters<typeof RepoPage>[0]["view"]) =>
			renderToStaticMarkup(
				<RepoPage
					repo="acme/web"
					view={view}
					snapshot={{ ...repo, branches: [{ name: "release/2.4", base: "b", at: "" }] }}
					api={stubApi()}
				/>,
			).match(/<span>Changes<\/span>.*?data-slot="counter"[^>]*>(\d+)</)?.[1];
		expect(tab({ kind: "repo", tab: "changes" })).toBe("3");
		expect(tab({ kind: "repo", tab: "changes", branch: "release/2.4" })).toBe("1");
		expect(tab({ kind: "repo", tab: "audit" })).toBe("3");
	});
});
