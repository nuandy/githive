import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeAwareness, ChangeHistory, RepoSnapshot } from "../api";
import { historyFixture, inlineText, repoSnapshot } from "../test/fixtures";
import { Awareness } from "./Awareness";
import { ChangePage } from "./ChangePage";

// What a change's page says agents hear about it: where its code meets other open changes, its conflict with its
// branch, its earlier attempts to land, and how long its claim lasts.

type Claim = RepoSnapshot["claims"][number];
const holder = (change: string, agent: string): Claim => ({
	...repoSnapshot.claims[0]!,
	change,
	agent,
	intent: `${change}'s intent`,
	hosted: undefined,
});
const claims = [repoSnapshot.claims[0]!, holder("c-3", "carol"), holder("c-9", "bob")];
const BEFORE = "export function loadSettings(path: string): Settings";
const AFTER = "export function loadSettings(path: string): Result<Settings>";

const awareness: ChangeAwareness = {
	change: "c-1",
	agent: "agent-c",
	branch: "main",
	head: "b1c2d3e4f5a6",
	base: "base",
	at: 1,
	alters: [
		{ file: "src/config.ts", altered: { name: "loadSettings", change: "interface", before: BEFORE, after: AFTER } },
	],
	uses: [{ file: "src/store.ts", name: "Store", at: [{ file: "src/c/cache.ts", line: 3 }] }],
	usedBy: [
		{
			file: "src/config.ts",
			altered: { name: "loadSettings", change: "interface", before: BEFORE, after: AFTER },
			imported: "loadSettings",
			at: [{ file: "src/jobs/sync.ts", line: 4 }],
			other: { by: "carol", change: "c-3", intent: "c-3's intent" },
		},
		// The same name used again through the whole file: one line, with both sites.
		{
			file: "src/config.ts",
			altered: { name: "loadSettings", change: "interface", before: BEFORE, after: AFTER },
			imported: "*",
			at: [
				{ file: "src/jobs/sync.ts", line: 4 },
				{ file: "src/jobs/all.ts", line: 7 },
			],
			other: { by: "carol", change: "c-3", intent: "c-3's intent" },
		},
		// A change whose claim is gone isn't told.
		{
			file: "src/config.ts",
			altered: { name: "loadSettings", change: "interface", before: BEFORE, after: AFTER },
			imported: "loadSettings",
			at: [{ file: "src/old.ts", line: 1 }],
			other: { by: "dan", change: "c-4" },
		},
	],
	alteredBy: [
		{
			file: "src/store.ts",
			altered: { name: "Store.get", change: "removed", before: "get(key: string): string" },
			imported: "Store",
			at: [{ file: "src/c/cache.ts", line: 3 }],
			other: { by: "bob", change: "c-9", intent: "c-9's intent" },
		},
	],
};

const render = (aware: ChangeAwareness, head: string | null = "b1c2d3e4f5a6") =>
	renderToStaticMarkup(<Awareness awareness={aware} claims={claims} head={head} repo="acme/docs-site" />);

describe("where a change meets other open changes", () => {
	it("says what it alters that others use, and what it uses that others alter, each linking the other change", () => {
		const html = render(awareness);
		const text = inlineText(html);
		expect(text).toContain("Where it meets other open changes");
		expect(text).toContain("What it alters that others use");
		expect(text).toContain(
			"alters loadSettings (signature), used by carol's c-3 at src/jobs/sync.ts:4, src/jobs/all.ts:7",
		);
		expect(text).toContain(`${BEFORE} → ${AFTER}`);
		expect(text).toContain("What it uses that others alter");
		expect(text).toContain("uses Store.get, which bob's c-9 removes · used here at src/c/cache.ts:3");
		expect(html).toContain('<a href="#/repos/acme/docs-site/changes/c-3" title="c-3&#x27;s intent">c-3</a>');
		expect(html).toContain('href="#/repos/acme/docs-site/changes/c-9"');
		expect(text).not.toContain("dan");
		expect(text).toContain("read at b1c2d3e.");
	});

	it("links what's in this change's own files to them in its Files tab", () => {
		const html = renderToStaticMarkup(
			<Awareness
				awareness={awareness}
				claims={claims}
				head="b1c2d3e4f5a6"
				repo="acme/docs-site"
				fileHref={(path) => `#/files/${path}`}
			/>,
		);
		// What it alters is in its own file; where it uses another's is in its own files too.
		expect(html).toMatch(/<a href="#\/files\/src\/config\.ts"[^>]*><code>loadSettings<\/code><\/a>/);
		expect(html).toMatch(/<a href="#\/files\/src\/c\/cache\.ts"[^>]*><code>src\/c\/cache\.ts:3<\/code><\/a>/);
		// Where another change uses it is that change's, not this one's.
		expect(html).not.toContain('href="#/files/src/jobs/sync.ts"');
	});

	it("says when nothing meets, and when its footprint was read before the latest push", () => {
		const quiet = render({ ...awareness, usedBy: [], alteredBy: [] }, "ffff0000");
		const text = inlineText(quiet);
		expect(text).toContain(
			"Nothing it alters is used by another open change, and nothing it uses is being altered: it alters 1 name and uses 1 name of other files.",
		);
		expect(text).toContain("read at b1c2d3e (before its latest push).");
		expect(text).not.toContain("What it alters that others use");
		// The names past the server's caps count too.
		const capped = render({ ...awareness, usedBy: [], alteredBy: [], omitted: { alters: 60, uses: 4 } });
		expect(inlineText(capped)).toContain("it alters 61 names and uses 5 names of other files.");
	});

	it("says how many it left out past the server's caps", () => {
		expect(inlineText(render({ ...awareness, omitted: { usedBy: 7, alteredBy: 2 } }))).toContain(
			"And 9 more not shown.",
		);
	});
});

describe("a change's page, with what its agent hears", () => {
	const at = (hour: number, minute: number) => new Date(2026, 9, 11, hour, minute).getTime();
	const now = at(14, 0);
	const leased = (lease: Claim["lease"]): Claim => ({ ...claims[0]!, lease });
	const history: ChangeHistory = {
		...historyFixture,
		merge: {
			head: "b1c2d3e4f5a6",
			into: "main",
			branchHead: "9f8e7d6c5b4a",
			clean: false,
			conflicts: ["src/c/x.ts"],
			touchedBy: [{ file: "src/c/x.ts", commit: "6584265aaaa", change: "c-7", agent: "alice" }],
			hunks: [{ file: "src/c/x.ts", content: "<<<<<<< ours (changes/c-1)", truncated: false }],
			fix: ["git fetch origin main && git merge origin/main"],
		},
		attempts: ["conflict on src/c/x.ts with c-7 by alice (6584265)", "checks failed: npm test exited 1"],
		awareness,
	};
	const page = (claim: Claim, shown: ChangeHistory = history) =>
		renderToStaticMarkup(
			<ChangePage
				snapshot={{ ...repoSnapshot, claims }}
				changeId="c-1"
				claim={claim}
				history={shown}
				repo="acme/docs-site"
				tab="conversation"
				now={now}
			/>,
		);

	it("shows its earlier attempts in the timeline, then its conflict and where it meets others", () => {
		const html = page(leased({ waitingOn: "reviewers" }));
		const text = inlineText(html);
		// The decision box comes first; then the conversation, in its order.
		const conversation = text.slice(text.indexOf("opened this change"));
		expect(text.indexOf("review: 1 of 2")).toBeLessThan(text.indexOf("opened this change"));
		const order = [
			"First draft of section C",
			"an attempt to land conflicted with its branch",
			"conflict on src/c/x.ts with c-7 by alice (6584265)",
			"an attempt to land failed its checks",
			"Conflicts with main",
			"What the agent will do",
			"Where it meets other open changes",
		].map((words) => conversation.indexOf(words));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("says when the claim frees up if its agent doesn't answer, or why it never does", () => {
		expect(inlineText(page(leased({ waitingOn: "agent", freeAfter: new Date(at(14, 30)).toISOString() })))).toContain(
			"Another agent asked whether its agent is still there. Free after 14:30 unless its agent answers.",
		);
		expect(inlineText(page(leased({ waitingOn: "agent", freeAfter: new Date(at(13, 45)).toISOString() })))).toContain(
			"Free since 13:45: its agent didn't answer when asked, so the agent that asked may take its paths.",
		);
		expect(inlineText(page(leased({ waitingOn: "agent" })))).toContain(
			"Lasts until another agent needs its paths and its agent doesn't answer.",
		);
		expect(inlineText(page(leased({ waitingOn: "reviewers" })))).toContain("Doesn't free up while it waits on review.");
		expect(inlineText(page(leased({ waitingOn: "landing" })))).toContain(
			"Doesn't free up while it is being checked to land.",
		);
		expect(inlineText(page(leased({ waitingOn: "person" })))).toContain("Doesn't free up while it waits on a person.");
		// Older servers don't say.
		expect(inlineText(page(leased(undefined)))).not.toContain("free");
	});

	it("shows no conflict or awareness once the claim is gone", () => {
		const released: ChangeHistory = {
			...history,
			claim: null,
			released: [{ reason: "gave up", at: new Date(now).toISOString(), agent: "agent-c" }],
		};
		const html = renderToStaticMarkup(
			<ChangePage
				snapshot={{ ...repoSnapshot, claims: [] }}
				changeId="c-1"
				history={released}
				repo="acme/docs-site"
				tab="conversation"
			/>,
		);
		const text = inlineText(html);
		expect(text).not.toContain("Conflicts with main");
		expect(text).not.toContain("Where it meets other open changes");
		// Its attempts are its history: they come before how it ended.
		expect(text.indexOf("an attempt to land failed its checks")).toBeLessThan(text.indexOf("released the claim"));
	});
});
