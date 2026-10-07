import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox } from "../lib/inbox";
import { ago, freeHistory, freeSnapshot, stubApi } from "../test/fixtures";
import { FreeAgents } from "./Agents";
import { FreeCommits } from "./Commits";
import { InboxPage } from "./InboxPage";
import { LiveDot } from "./RepoHeader";
import { FreeRepoPage } from "./RepoPage";
import { FreeSettings } from "./FreeRepo";
import { TopBar } from "./TopBar";

// The repo tabs and pages beside the change list: commits, the inbox, agents,
// the header and settings.

describe("the Commits tab", () => {
	it("lists a change's commits with their messages", () => {
		const html = renderToStaticMarkup(<FreeCommits history={freeHistory} repo="docs" base="free" />);
		expect(html).toContain("Tighten the wording");
		expect(html).toContain("And fix two links.");
		expect(html).toContain("First draft of section C");
		expect(html).toContain("<strong>agent-c</strong> committed");
		expect(renderToStaticMarkup(<FreeCommits history={undefined} repo="docs" base="free" />)).toContain("Loading commits");
	});
});

describe("the Inbox", () => {
	const summaries = {
		free: [{ repo: "my-app", since: ago(10), summary: { waiting: [{ change: "fix-login", title: "Fix login", reason: "Reviewers disagree after 3 revisions" }] } }],
	};

	it("lists what waits on you, grouped by repo, each linking to its change", () => {
		const { groups } = buildInbox(summaries);
		const html = renderToStaticMarkup(<InboxPage groups={groups} loaded />);
		expect(html).toContain('<a href="#/repos/my-app">my-app</a>');
		expect(html).toContain('<a href="#/repos/my-app/changes/fix-login" class="inbox__title">Fix login</a>');
		expect(html).toContain("Reviewers disagree after 3 revisions");
	});

	it("says when nothing waits, and counts in the top bar", () => {
		expect(renderToStaticMarkup(<InboxPage groups={[]} loaded />)).toContain("Nothing waits on you");
		const bar = renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={3} />);
		expect(bar).toContain('href="#/inbox"');
		expect(bar).toContain('aria-label="Inbox, 3 waiting on you"');
		expect(bar).toMatch(/topbar__inbox-count">3</);
		expect(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={0} />)).not.toContain("topbar__inbox-count");
	});
});

describe("Agents", () => {
	it("lists who holds claims and who reviews", () => {
		const html = renderToStaticMarkup(<FreeAgents snapshot={freeSnapshot} />);
		expect(html).toContain("agent-c");
		expect(html).toContain("rev-1");
		expect(html).toContain("Claims in force");
	});
});

describe("the repo header", () => {
	it("shows a live dot while connected or reconnecting, and the repo's tabs", () => {
		expect(renderToStaticMarkup(<LiveDot status="live" />)).toMatch(/live-dot--live.*Live/);
		expect(renderToStaticMarkup(<LiveDot status="reconnecting" />)).toContain("Reconnecting");
		expect(renderToStaticMarkup(<LiveDot status="off" />)).toBe("");
		const page = renderToStaticMarkup(<FreeRepoPage repo="docs-site" base="repos" view={{ kind: "repo", tab: "changes" }} snapshot={freeSnapshot} liveStatus="live" api={stubApi()} />);
		expect(page).toContain("live-dot--live");
		for (const tab of ["Changes", "Claims", "Code", "Agents", "Audit", "Settings"]) expect(page).toContain(`<span>${tab}</span>`);
		expect(page).not.toMatch(/elected|Insights|Activity/);
	});
});

describe("Settings", () => {
	it("says the settings can't be changed here", () => {
		expect(renderToStaticMarkup(<FreeSettings snapshot={freeSnapshot} />)).toMatch(/can.{1,6}t be changed here.*free_start/);
	});
});
