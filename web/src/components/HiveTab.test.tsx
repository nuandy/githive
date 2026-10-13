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
		// The brief is one click away, not in the row.
		expect(text).not.toContain("put the game together");
		expect(html).toContain(`title="${BRIEF.replace(/'/g, "&#x27;")}"`);
		expect(text).not.toContain("an agent");
		expect(text).not.toContain("bfa0f510");
	});

	it("says what needs a person above everything", () => {
		const attention = { reason: "should sendFile follow symlinks?", agent: "agent-12", at: ago(1) };
		const text = visibleText(
			render({ snapshot: { ...repoSnapshot, claims: [claim("ask", { attention })], votes: [] } }),
		);
		expect(text).toContain("Needs a person:");
		expect(text).toContain("agent-12 asks “should sendFile follow symlinks?”");
		// The fixture's audit flags a merge.
		expect(text).toContain("1 merge for the audit to look at");
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
