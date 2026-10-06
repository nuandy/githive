import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildInbox } from "../lib/inbox";
import { ago, approve, freeHistory, freeSnapshot, makeChange, makeTask, reject, stubApi } from "../test/fixtures";
import { ElectedAgents, FreeAgents } from "./Agents";
import { ChangeCommits, FreeCommits } from "./Commits";
import { InboxPage } from "./InboxPage";
import { Insights } from "./Insights";
import { CoordinatorLine, LiveDot } from "./RepoHeader";
import { ElectedRepoPage } from "./RepoPage";
import { RepoSettings } from "./RepoSettings";
import { FreeSettings } from "./FreeRepo";
import { TopBar } from "./TopBar";

const usage = { usage: { inputTokens: 2000, outputTokens: 500 } };
const task = makeTask({
	id: "abcd1234",
	agents: { "agent-a": { keyHash: "h", at: ago(300) } },
	slices: [
		makeChange({ id: "add-stats", title: "Add stats page", openedBy: "agent:agent-a", status: "integrated", openedAt: ago(120), endedAt: ago(60), reviews: [{ ...approve("tests", "h1"), ...usage }] }),
		makeChange({ id: "fix-login", title: "Fix login", openedBy: "agent:agent-a", reviews: [reject("security", "h2")], revisions: 1 }),
	],
});

describe("the Commits tab", () => {
	it("lists an elected change's pushes newest first, with conflict and outside-claim badges", () => {
		const change = makeChange({
			reviewHead: "bbbbbbbbbb",
			pushes: [
				{ head: "aaaaaaaaaa", at: ago(30), files: 1, outOfLane: 0, conflicts: 0 },
				{ head: "bbbbbbbbbb", at: ago(5), files: 3, outOfLane: 1, conflicts: 2 },
			],
		});
		const html = renderToStaticMarkup(<ChangeCommits change={change} repo="my-app" base="repos" />);
		expect(html.indexOf("bbbbbbb")).toBeLessThan(html.indexOf("aaaaaaa"));
		expect(html).toContain("3 files changed");
		expect(html).toContain("2 conflicts");
		expect(html).toContain("1 outside its claim");
		expect(html).toContain("no conflicts");
		expect(html).toContain("in review");
		expect(html).toContain('href="#/repos/my-app/code?ref=bbbbbbbbbb"');
		expect(renderToStaticMarkup(<ChangeCommits change={makeChange()} repo="my-app" base="repos" />)).toContain("No pushes yet");
	});

	it("lists a coordinator-free change's commits with their messages", () => {
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
		tasks: [{ id: "abcd1234", repo: "my-app", createdAt: ago(10), elected: true, summary: { waiting: [{ change: "fix-login", title: "Fix login", reason: "Reviewers disagree after 3 revisions" }] } }],
		free: [],
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

describe("Insights and Agents", () => {
	it("shows throughput, review outcomes and cost as cards and bars", () => {
		const html = renderToStaticMarkup(<Insights task={task} history={null} />);
		expect(html).toContain("Median time to merge");
		expect(html).toContain("1 hour");
		expect(html).toContain("Approved at first review");
		expect(html).toContain("2.5k tokens");
		expect(html).toMatch(/aria-label="tests: 1 approved, 0 requested changes"/);
		expect(renderToStaticMarkup(<Insights task={makeTask()} />)).toContain("No changes yet");
	});

	it("lists registered agents, authors and reviewers", () => {
		const html = renderToStaticMarkup(<ElectedAgents task={task} />);
		expect(html).toContain("Registered outside agents");
		expect(html).toContain("<strong>agent-a</strong>");
		expect(html).toContain("Blueprint&#x27;s tests reviewer");
		expect(html).toContain("Blueprint&#x27;s security reviewer");
		const free = renderToStaticMarkup(<FreeAgents snapshot={freeSnapshot} />);
		expect(free).toContain("agent-c");
		expect(free).toContain("rev-1");
	});
});

describe("the repo header", () => {
	it("says who coordinates, and when nobody does", () => {
		const html = renderToStaticMarkup(<CoordinatorLine leader={{ leader: "abcd1234--fix-login", term: 4 }} task={task} repo="my-app" base="repos" />);
		expect(html).toContain('Coordinated by <a href="#/repos/my-app/changes/fix-login">Fix login</a>');
		expect(html).toContain("term 4");
		expect(html).toMatch(/title="There is no central server here/);
		expect(renderToStaticMarkup(<CoordinatorLine leader={{ leader: null, term: 3 }} task={task} repo="my-app" base="repos" />)).toContain(
			"No coordinator elected now — the next change to arrive elects one",
		);
		expect(renderToStaticMarkup(<CoordinatorLine task={task} repo="my-app" base="repos" />)).toBe("");
	});

	it("shows a live dot while connected or reconnecting", () => {
		expect(renderToStaticMarkup(<LiveDot status="live" />)).toMatch(/live-dot--live.*Live/);
		expect(renderToStaticMarkup(<LiveDot status="reconnecting" />)).toContain("Reconnecting");
		expect(renderToStaticMarkup(<LiveDot status="off" />)).toBe("");
		const page = renderToStaticMarkup(
			<ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "changes", state: "open" }} task={task} leader={{ leader: null, term: 1 }} liveStatus="live" api={stubApi()} onChanged={() => undefined} />,
		);
		expect(page).toContain("live-dot--live");
		expect(page).toContain("No coordinator elected now");
		for (const tab of ["Changes", "Activity", "Claims", "Code", "Insights", "Agents", "Settings"]) expect(page).toContain(`<span>${tab}</span>`);
	});
});

describe("Settings", () => {
	it("edits stricter path rules and outside reviewers", () => {
		const strict = makeTask({
			review: { reviewers: ["review"], required: 1, vetoes: [], external: ["review"], externalWaitMinutes: 90, escalate: [{ paths: ["package.json"], reviewers: ["security"], required: 2, vetoes: ["security"] }] },
		});
		const html = renderToStaticMarkup(<RepoSettings task={strict} api={stubApi()} />);
		expect(html).toMatch(/aria-label="Outside agents review review" checked=""/);
		expect(html).toMatch(/<textarea id="rule-0-paths"[^>]*>package.json<\/textarea>/);
		expect(html).toMatch(/id="rule-0-roles"[^>]*value="security"/);
		expect(html).toMatch(/id="settings-wait"[^>]*value="90"/);
		expect(html).toContain("Roles only these rules add");
		expect(html).toMatch(/<button type="submit" class="primary" disabled="">Save settings<\/button>/);
	});

	it("says coordinator-free settings can't be changed here", () => {
		expect(renderToStaticMarkup(<FreeSettings snapshot={freeSnapshot} />)).toMatch(/can.{1,6}t be changed here.*free_start/);
	});
});
