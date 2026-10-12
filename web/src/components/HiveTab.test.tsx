import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ago, inlineText, NOW, repoSnapshot, visibleText } from "../test/fixtures";
import { Hive } from "./HiveTab";

// The Hive tab: who works on the repo, what each is doing, and that nothing assigns the work.

describe("the Hive tab", () => {
	it("leads with the agents at work and how they're coordinated, then lists each agent's change", () => {
		// rev-1 reviewed five minutes ago, so it's still in the hive.
		const votes = repoSnapshot.votes.map((vote) => ({ ...vote, at: ago(5) }));
		const snapshot = { ...repoSnapshot, votes };
		const html = renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={snapshot} now={NOW} />);
		const text = visibleText(html);
		expect(text).toContain("2 agents in the hive");
		expect(text).toContain("No queen: nothing assigns the work");
		expect(text).toContain("agent-c in review c-1 1 of 2 approvals");
		expect(text).toContain("rev-1 reviewing c-1 approved c-1");
		expect(html).toContain('href="#/repos/acme/docs-site/changes/c-1"');
	});

	it("says how to bring the first agent in when the hive is empty", () => {
		const empty = { ...repoSnapshot, claims: [], votes: [] };
		const text = visibleText(
			renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={empty} now={NOW} />),
		);
		expect(text).toContain("No agents in the hive yet");
	});

	it("shows what just happened, newest first, in the feed", () => {
		const events = [
			{ kind: "landed" as const, agent: "agent-c", change: "c-1", commit: "c0ffee", at: ago(1) },
			{ kind: "pushed" as const, change: "c-1", commit: "b1c2d3e4f5a6", at: ago(3) },
		];
		const html = renderToStaticMarkup(
			<Hive repo="acme/docs-site" branch="main" snapshot={repoSnapshot} events={events} showsFeed now={NOW} />,
		);
		const text = visibleText(html);
		expect(text).toContain("Right now");
		expect(text.indexOf("agent-c landed c-1")).toBeLessThan(text.indexOf("agent-c pushed to c-1"));
	});

	it("marks what agents hear apart in the feed, each linking to the change it's about", () => {
		const claim = repoSnapshot.claims[0]!;
		const claims = [
			{ ...claim, change: "c-12", agent: "bob" },
			{ ...claim, change: "c-3", agent: "bob" },
			{ ...claim, change: "c-9", agent: "dan" },
		];
		const events = [
			{
				kind: "interface" as const,
				agent: "alice",
				change: "c-12",
				other: "bob",
				commit: "0123456789ab",
				detail: "loadSettings",
				at: ago(1),
			},
			{
				kind: "heads_up" as const,
				agent: "bob",
				change: "c-3",
				other: "carol",
				detail: "loadSettings, Store",
				at: ago(2),
			},
			{ kind: "conflicted" as const, agent: "dan", change: "c-9", detail: "invoice.ts", at: ago(3) },
			{ kind: "landed" as const, agent: "dan", change: "c-8", commit: "c0ffee", at: ago(4) },
		];
		const html = renderToStaticMarkup(
			<Hive
				repo="acme/docs-site"
				branch="main"
				snapshot={{ ...repoSnapshot, claims }}
				events={events}
				showsFeed
				now={NOW}
			/>,
		);
		// Each feed line's words, up to its time.
		const feed = html
			.split('<li class="hive-tab__event')
			.slice(1)
			.map((line) => inlineText(line.slice(line.indexOf(">") + 1, line.indexOf("<time"))));
		expect(feed).toEqual([
			"alice landed an interface change bob uses in c-12 · loadSettings",
			"bob and carol are changing things each other uses in bob's c-3 · loadSettings, Store",
			"dan's merge conflicted on invoice.ts in c-9",
			"dan landed c-8",
		]);
		for (const change of ["c-12", "c-3", "c-9"])
			expect(html).toContain(`href="#/repos/acme/docs-site/changes/${change}"`);
		// Each with a quiet marker of its own, named for screen readers; what agents did has none.
		expect(html).toMatch(
			/hive-tab__event--interface"><span><svg class="icon hive-tab__marker"[^>]*aria-label="Interface change"/,
		);
		expect(html).toMatch(
			/hive-tab__event--heads_up"><span><svg class="icon hive-tab__marker"[^>]*aria-label="Heads-up"/,
		);
		expect(html).toMatch(
			/hive-tab__event--conflicted"><span><svg class="icon hive-tab__marker"[^>]*aria-label="Conflict"/,
		);
		expect(html).toMatch(/hive-tab__event--landed"><span><strong>/);
	});

	it("says the feed is quiet when nothing has happened lately", () => {
		const html = renderToStaticMarkup(
			<Hive repo="acme/docs-site" branch="main" snapshot={repoSnapshot} events={[]} showsFeed now={NOW} />,
		);
		expect(visibleText(html)).toContain("Quiet: nothing has happened lately.");
	});

	it("says all its work landed, how much, and what the audit found, once nothing's open", () => {
		const done = { ...repoSnapshot, claims: [], votes: [], audit: { merges: 200, open: 0, violations: [] } };
		const landing = {
			branch: "main",
			checking: null,
			recent: [],
			stretch: { landed: 200, failed: 0, agents: 200, from: ago(37), to: ago(5) },
		};
		const text = visibleText(
			renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={done} landing={landing} now={NOW} />),
		);
		expect(text).toContain("✓ All landed. The hive is quiet.");
		expect(text).toContain("200 changes in 32 minutes, by 200 agents, finished 5 minutes ago. The audit is clean.");
	});

	it("says when the last work finished once that was hours ago", () => {
		const quiet = { ...repoSnapshot, claims: [], votes: [] };
		const landing = {
			branch: "main",
			checking: null,
			recent: [],
			stretch: { landed: 3, failed: 0, agents: 2, from: ago(300), to: ago(290) },
		};
		const text = visibleText(
			renderToStaticMarkup(<Hive repo="acme/docs-site" branch="main" snapshot={quiet} landing={landing} now={NOW} />),
		);
		expect(text).toContain("No agents in the hive now");
		expect(text).toContain("Its last stretch of work finished");
	});
});
