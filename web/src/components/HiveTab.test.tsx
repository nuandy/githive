import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HiveEvent, RepoSnapshot } from "../api";
import { hiveGoals } from "../lib/goals";
import { ago, NOW, repoSnapshot, visibleText } from "../test/fixtures";
import { GoalsPanel, stepLead } from "./GoalsPanel";
import { Hive } from "./HiveTab";

// The Hive tab: each goal an agent announced and what became of it, the stages they're at, and what needs a person.

type Claim = RepoSnapshot["claims"][number];

const BRIEF =
	"Wire up the game src/main.js: put the game together as README.md describes: today's puzzle, progress loaded and saved after every word, the board, typing and controls.";

const claim = (change: string, extra: Partial<Claim> = {}): Claim => ({
	change,
	agent: "agent-12",
	paths: ["lib/request.js"],
	intent: "Fix: an IPv6 Host header loses its port",
	since: ago(18),
	active: ago(1),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...extra,
});

const render = (props: Partial<Parameters<typeof Hive>[0]> = {}) =>
	renderToStaticMarkup(<Hive repo="acme/web" branch="main" snapshot={repoSnapshot} now={NOW} {...props} />);

describe("the Hive tab", () => {
	it("counts the goals at each stage, and shows each as one row: title, agent, where it stands", () => {
		const claims = [
			claim("ipv6", { head: "a1b2" }),
			claim("brotli", { agent: "carol-claude", intent: "Add brotli to res.sendFile", since: ago(1) }),
		];
		const text = visibleText(render({ snapshot: { ...repoSnapshot, claims, votes: [] } }));
		expect(text).toMatch(/1 building/);
		expect(text).toMatch(/1 in review/);
		expect(text).toContain("In flight · 2");
		// Newest arrival first.
		expect(text.indexOf("Add brotli to res.sendFile")).toBeLessThan(
			text.indexOf("Fix: an IPv6 Host header loses its port"),
		);
		expect(text).toContain("in review · 0 of 1 · agent-12 · 18 minutes · lib/request.js");
	});

	it("folds a finished goal's claims, push, vote and landing into one row, named even though its claim is gone", () => {
		const events: HiveEvent[] = [
			{ kind: "landed", agent: "githive-forager", change: "app", commit: "f00d", at: ago(6) },
			{ kind: "merging", agent: "githive-forager", change: "app", at: ago(6) },
			{ kind: "voted", agent: "githive-nurse", commit: "bfa0f510", verdict: "approve", detail: "code", at: ago(7) },
			{ kind: "pushed", change: "app", commit: "bfa0f510", at: ago(7) },
			{ kind: "claimed", agent: "githive-forager", change: "app", detail: BRIEF, at: ago(9) },
		];
		const html = render({ snapshot: { ...repoSnapshot, claims: [], votes: [] }, events });
		const text = visibleText(html);
		expect(text).toContain("✓ 1 landed");
		expect(text).toContain("Wire up the game src/main.js");
		// The brief is one click away, not in the row; the title goes to the change, and the chevron opens the row.
		expect(text).not.toContain("put the game together");
		expect(html).toMatch(/<a [^>]*href="#\/repos\/acme\/web\/changes\/app"[^>]*>Wire up the game src\/main.js<\/a>/);
		expect(html).toMatch(/<button [^>]*aria-expanded="false" aria-controls="steps-app" aria-label="Steps of Wire up/);
		expect(text).not.toContain("an agent");
		expect(text).not.toContain("bfa0f510");
	});

	it("says what needs a person above everything", () => {
		const attention = { reason: "should sendFile follow symlinks?", agent: "agent-12", at: ago(1) };
		const text = visibleText(
			render({ snapshot: { ...repoSnapshot, claims: [claim("ask", { attention })], votes: [] } }),
		);
		// A row each: who asks and how long ago, the question on one line, and what to do about it.
		expect(text).toContain("Needs a person agent-12 asks · 1m “should sendFile follow symlinks?” Answer →");
		// The fixture's audit flags a merge.
		expect(text).toContain("The audit flags 1 open violation to look at See the audit →");
	});

	it("lists three things that need a person, and says how many more the Inbox has", () => {
		const asks = ["a", "b", "c", "d"].map((change, index) =>
			claim(change, { attention: { reason: `question ${change}?`, agent: "agent-12", at: ago(index + 1) } }),
		);
		const html = render({ snapshot: { ...repoSnapshot, claims: asks, votes: [] } });
		const banner = /aria-labelledby="needs-person-title".*?<\/section>/.exec(html)![0];
		const text = visibleText(banner);
		// Waiting longest first, as the Inbox lists them.
		expect(text).toContain("question d?");
		expect(text).toContain("question b?");
		expect(text).not.toContain("question a?");
		// The newest question and the audit's flag.
		expect(text).toContain("+2 more. See them in the Inbox");
		expect(banner).toContain('href="#/inbox"');
		// The Inbox has what waits on other branches too; the banner counts it among what it leaves out.
		const more = visibleText(render({ snapshot: { ...repoSnapshot, claims: asks, votes: [] }, waitingElsewhere: 2 }));
		expect(more).toContain("+4 more, 2 of them on other branches. See them in the Inbox");
		const one = { ...repoSnapshot, claims: asks.slice(0, 2), votes: [], audit: undefined };
		expect(visibleText(render({ snapshot: one, waitingElsewhere: 1 }))).toContain(
			"+1 more on another branch. See it in the Inbox",
		);
	});

	it("asks a person for a vote only people may give, and leaves failed checks to the goal's own row", () => {
		const approval = { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] };
		const policy = { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } };
		const claims = [
			claim("deps", { head: "d1", approval, intent: "Bump the router" }),
			claim("fix", { head: "f1", intent: "Fix the cookie parser" }),
		];
		const checks = {
			commit: "f1",
			reviewer: "githive-checks",
			role: "checks",
			verdict: "reject" as const,
			evidence: "npm test exited 1",
			at: ago(2),
		};
		const landing = {
			branch: "main",
			checking: null,
			recent: [{ change: "fix", head: "f1", agent: "agent-12", how: "failed" as const, at: ago(2) }],
		};
		const text = visibleText(
			render({ snapshot: { ...repoSnapshot, policy, claims, votes: [checks], audit: undefined }, landing }),
		);
		expect(text).toContain(
			"Bump the router · 1m waits for a security vote, which only people may give Vote as security →",
		);
		expect(text).not.toContain("its checks failed");
		expect(text).toContain("checks failed, fixing");
	});

	it("counts approved changes apart from landing ones: amber is only what's checked to land", () => {
		const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };
		const text = visibleText(
			render({ snapshot: { ...repoSnapshot, claims: [claim("ok", { head: "a1", approval: approved })], votes: [] } }),
		);
		expect(text).toMatch(/1 approved/);
		expect(text).toMatch(/0 landing/);
	});

	it("says all its work landed, how much, and what the audit found, once nothing's in flight", () => {
		const done = { ...repoSnapshot, claims: [], votes: [], audit: { merges: 200, open: 0, violations: [] } };
		const landing = {
			branch: "main",
			checking: null,
			recent: [],
			stretch: { landed: 200, failed: 0, agents: 200, from: ago(37), to: ago(5) },
		};
		const text = visibleText(render({ snapshot: done, landing }));
		expect(text).toContain(
			"✓ All landed. 200 changes in 32 minutes, by 200 agents, finished 5 minutes ago. The audit is clean.",
		);
	});

	it("says how to bring the first agent in when the hive is empty, and when the last work finished", () => {
		const empty = { ...repoSnapshot, claims: [], votes: [] };
		expect(visibleText(render({ snapshot: empty }))).toContain("No agents in the hive yet");
		// The goals show a sample row instead of an empty clock.
		expect(visibleText(render({ snapshot: empty }))).toContain(
			"No goals yet. Each change an agent claims here becomes a row",
		);
		expect(visibleText(render())).not.toContain("No goals yet");
		// The sample is marked as one, its words at muted text's full contrast: only its bars are faint.
		const sample = /<div class="[^"]*border-dashed[^"]*" aria-hidden="true">.*?<\/div><p/.exec(
			render({ snapshot: empty }),
		)![0];
		expect(visibleText(sample)).toContain("Example ? What an agent sets out to do where it stands");
		expect(sample).toMatch(/<span class="[^"]*text-muted-foreground[^"]*">What an agent sets out to do<\/span>/);
		expect(sample.match(/opacity-55/g)).toHaveLength(1);
		expect(sample).toMatch(/<span class="[^"]*opacity-55[^"]*"><span class="absolute top-1\/2/);
		const landing = {
			branch: "main",
			checking: null,
			recent: [],
			stretch: { landed: 3, failed: 0, agents: 2, from: ago(300), to: ago(290) },
		};
		const text = visibleText(render({ snapshot: empty, landing }));
		expect(text).toContain("No agents in the hive now");
		expect(text).toContain("Its last stretch of work finished");
	});

	it("opens as its address says: the window, the view, the agent shown and the row open", () => {
		const claims = [claim("ipv6", { head: "a1" }), claim("brotli", { agent: "carol-claude", intent: "Add brotli" })];
		const html = render({
			snapshot: { ...repoSnapshot, claims, votes: [] },
			query: { window: 6 * 60 * 60_000, view: "timeline", agent: "agent-12", row: "ipv6" },
		});
		expect(html).toContain('data-view="timeline"');
		expect(html).toMatch(/aria-pressed="true"[^>]*>6 h</);
		expect(visibleText(html)).toContain("only agent-12 ×");
		expect(html).toMatch(/aria-expanded="true" aria-controls="steps-ipv6"/);
	});

	it("asks for an answer on a change's page only when it needs a person, never while it's building", () => {
		const awaiting = { approved: false, approvals: 0, required: 1, vetoedBy: [], awaiting: ["security"] };
		const attention = { reason: "may I bump the router?", agent: "agent-12", at: ago(1) };
		const open = (extra: Partial<Claim>) =>
			visibleText(
				render({ snapshot: { ...repoSnapshot, claims: [claim("x", extra)], votes: [] }, query: { row: "x" } }),
			);
		// Still building, though a role waits to vote on it once it's pushed.
		expect(open({ approval: awaiting })).toContain("Open the change →");
		expect(open({ approval: awaiting })).not.toContain("Answer it on its page");
		expect(open({ attention })).toContain("Answer it on its page →");
	});

	it("gets someone who can write started: the command that connects an agent, a prompt naming the repo", () => {
		const empty = { ...repoSnapshot, claims: [], votes: [] };
		const html = render({ snapshot: empty, writes: true, origin: "https://githive.app" });
		const text = visibleText(html);
		expect(text).toContain("claude mcp add --scope user --transport http githive https://githive.app/mcp");
		expect(text).toContain("Use GitHive to find one small improvement and land it in acme/web.");
		expect(text).toContain("Waiting for the first claim…");
		// A visitor is told where agents come from, as before.
		expect(visibleText(render({ snapshot: empty }))).toContain("Connect an agent from the Agents page");
		expect(visibleText(render({ snapshot: empty }))).not.toContain("claude mcp add");
	});

	it("shows up next only when it knows the backlog", () => {
		const backlog = [{ id: "is-edges", title: "req.is tests", intent: "req.is tests", by: "planner", at: ago(30) }];
		expect(visibleText(render())).not.toContain("up next");
		expect(visibleText(render({ backlog }))).toMatch(/1 up next/);
	});
});

describe("the goals panel", () => {
	const goals = hiveGoals({
		claims: [claim("ipv6", { head: "a1" })],
		votes: [],
		events: [{ kind: "landed", agent: "agent-19", change: "links", at: ago(5) }],
	});
	const panel = (view: "story" | "timeline") =>
		renderToStaticMarkup(
			<GoalsPanel
				repo="acme/web"
				branch="main"
				goals={goals}
				range={60 * 60_000}
				onRange={() => undefined}
				lit={new Set()}
				filter={null}
				onFilter={() => undefined}
				motions={new Map()}
				unseen={new Set()}
				onSeen={() => undefined}
				onHover={() => undefined}
				now={NOW}
				view={view}
			/>,
		);

	it("folds finished goals into a summary in Story, and draws them as rows in Timeline", () => {
		const story = panel("story");
		expect(story).toContain('data-view="story"');
		expect(story).toContain('aria-expanded="false"');
		const timeline = panel("timeline");
		expect(timeline).toContain('data-view="timeline"');
		// The same rows either way; CSS morphs one into the other.
		expect(timeline.match(/<li [^>]*data-key=/g)).toHaveLength(story.match(/<li [^>]*data-key=/g)!.length);
	});

	it("puts the steps in words, an interface change and a heads-up as the goal's own", () => {
		expect(stepLead({ kind: "interface", at: ago(1), by: "alice", other: "bob" }, "main")).toBe(
			"alice landed a change to something it uses",
		);
		expect(stepLead({ kind: "heads-up", at: ago(1), by: "bob", other: "carol" }, "main")).toContain("carol's change");
		expect(stepLead({ kind: "changes-asked", at: ago(1), by: "githive-checks", role: "checks" }, "main")).toBe(
			"its checks failed",
		);
	});
});
