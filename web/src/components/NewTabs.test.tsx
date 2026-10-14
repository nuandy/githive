import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox } from "../lib/inbox";
import { ago, historyFixture, repoSnapshot, stubApi } from "../test/fixtures";
import { AgentsTab } from "./Agents";
import { ChangeCommits } from "./Commits";
import { InboxPage } from "./InboxPage";
import { LiveDot } from "./RepoHeader";
import { RepoPage } from "./RepoPage";
import { SettingsTab } from "./RepoTabs";
import { TopBar } from "./TopBar";

// The repo tabs and pages beside the change list: commits, the inbox, agents,
// the header and settings.

describe("the Commits tab", () => {
	it("lists a change's commits with their messages", () => {
		const html = renderToStaticMarkup(<ChangeCommits history={historyFixture} repo="docs" />);
		expect(html).toContain("Tighten the wording");
		expect(html).toContain("And fix two links.");
		expect(html).toContain("First draft of section C");
		expect(html).toContain("<strong>agent-c</strong> committed");
		expect(renderToStaticMarkup(<ChangeCommits history={undefined} repo="docs" />)).toContain("Loading commits");
	});
});

describe("the Inbox", () => {
	const summaries = {
		repos: [
			{
				repo: "acme/my-app",
				since: ago(10),
				summary: {
					waiting: [{ change: "fix-login", title: "Fix login", reason: "Reviewers disagree after 3 revisions" }],
				},
			},
		],
	};

	it("lists what waits on you, grouped by repo, each linking to its change", () => {
		const { groups } = buildInbox(summaries);
		const html = renderToStaticMarkup(<InboxPage groups={groups} loaded />);
		expect(html).toContain('<a href="#/repos/acme/my-app">acme/my-app</a>');
		expect(html).toMatch(/<a href="#\/repos\/acme\/my-app\/changes\/fix-login" class="[^"]*">Fix login<\/a>/);
		expect(html).toContain("Reviewers disagree after 3 revisions");
	});

	it("says when nothing waits, and counts in the top bar", () => {
		expect(renderToStaticMarkup(<InboxPage groups={[]} loaded />)).toContain("Nothing waits on you");
		const bar = renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={3} />);
		expect(bar).toContain('href="#/inbox"');
		expect(bar).toMatch(/Inbox<\/span> <span[^>]*>3<\/span><span class="sr-only"> waiting on you<\/span>/);
		expect(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={0} />)).not.toMatch(/Inbox<\/span> ?<span/);
	});
});

describe("Agents", () => {
	it("lists who holds claims and who reviews", () => {
		const html = renderToStaticMarkup(<AgentsTab repo="o/r" snapshot={repoSnapshot} />);
		expect(html).toContain("agent-c");
		expect(html).toContain("rev-1");
		expect(html).toContain("Claims in force");
	});
});

describe("the repo header", () => {
	it("shows a live dot while connected or reconnecting, and the repo's tabs", () => {
		// What the state means is a tooltip, reached by focus as well as by hover.
		const live = renderToStaticMarkup(<LiveDot status="live" />);
		expect(live).toMatch(/<span[^>]*tabindex="0"[^>]*data-state="closed"[^>]*>.*Live/);
		expect(live).not.toContain("title=");
		expect(renderToStaticMarkup(<LiveDot status="reconnecting" />)).toContain("Reconnecting");
		expect(renderToStaticMarkup(<LiveDot status="off" />)).toBe("");
		const page = renderToStaticMarkup(
			<RepoPage
				repo="acme/docs-site"
				view={{ kind: "repo", tab: "changes" }}
				snapshot={repoSnapshot}
				liveStatus="live"
				api={stubApi()}
			/>,
		);
		expect(page).toMatch(/role="status"[^>]*>.*>Live</);
		for (const tab of ["Changes", "Claims", "Code", "Agents", "Audit", "Settings"])
			expect(page).toContain(`<span>${tab}</span>`);
		expect(page).not.toMatch(/elected|Insights|Activity/);
	});
});

describe("Settings", () => {
	it("says the repo's admins set how changes merge, and that a role can go to a team", () => {
		const html = renderToStaticMarkup(<SettingsTab snapshot={repoSnapshot} />);
		expect(html).toContain("The repo&#x27;s admins set how changes merge");
		expect(html).toContain("@org/team");
	});

	it("shows a team granted a role as the grant names it", () => {
		const granted = {
			...repoSnapshot,
			policy: { ...repoSnapshot.policy, vetoes: ["security"], grants: { security: ["@acme/security", "person:*"] } },
		};
		expect(renderToStaticMarkup(<SettingsTab snapshot={granted} />)).toContain("security: @acme/security, people");
	});
});
