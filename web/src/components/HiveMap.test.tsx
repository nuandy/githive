import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { agentColor } from "../lib/honeycomb";
import { ago, NOW, visibleText } from "../test/fixtures";
import { HiveMap } from "./HiveMap";

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, agent: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent,
	paths,
	intent: `${change} work\n\nMore about it.`,
	since: ago(30),
	active: ago(1),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const head = "c".repeat(40);
const approved = { head, approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } };
const snapshot = { claims: [claim("stats", "agent-a", ["src/stats/"]), claim("docs", "agent-b", ["docs/"], approved), claim("web", "agent-c", ["web/"], approved)], votes: [] };
const landing = { branch: "main", checking: { base: "abc", since: ago(1), changes: [{ change: "docs", head, agent: "agent-b" }] }, recent: [] };
const tree = { ref: "main", commit: "abc", files: ["README.md", "docs/guide.md", "src/index.ts", "src/stats/page.tsx", "src/auth/login.ts", "web/app.tsx", "lib/x.ts"], truncated: false };
const render = (props: Partial<Parameters<typeof HiveMap>[0]> = {}) =>
	renderToStaticMarkup(<HiveMap repo="acme/web" branch="main" snapshot={snapshot} tree={tree} landing={landing} now={NOW} {...props} />);

describe("the hive map", () => {
	it("draws a focusable, labelled hexagon per folder, lit in its agent's color", () => {
		const html = render();
		const cells = html.match(/<g class="hive__cell[^"]*" role="button" tabindex="0"/g) ?? [];
		// docs, lib, src/* (its own files), src/auth, src/stats, web, and the top-level files.
		expect(cells).toHaveLength(7);
		expect(html).toContain(`hive__cell hive__cell--held claim-c${agentColor("agent-a")}`);
		expect(html).toContain('aria-label="src/stats/: held by agent-a for stats work, claimed 30 minutes ago, being built"');
		expect(html).toContain('aria-label="lib/: not claimed"');
		expect(html).toContain("<polygon");
	});

	it("marks cells whose change is being checked to land, or approved and waiting", () => {
		const html = render();
		expect(html).toMatch(/hive__cell--checking[^>]*aria-label="docs\/: held by agent-b[^"]*being checked to land"/);
		expect(html).toMatch(/hive__cell--queued[^>]*aria-label="web\/: held by agent-c for web work, claimed 30 minutes ago, approved"/);
		expect(html).toContain('class="hive__lamp"');
	});

	it("keeps a legend of agents with their changes and where each is", () => {
		const text = visibleText(render());
		expect(text).toContain("agent-a stats work · being built");
		expect(text).toContain("agent-b docs work · being checked to land");
		expect(render()).toContain('href="#/repos/acme/web/changes/stats"');
	});

	it("says when nothing is held, while the tree loads, and when it can't be read", () => {
		expect(render({ snapshot: { claims: [], votes: [] } })).toContain("every folder is free");
		expect(render({ tree: undefined })).toContain("Reading the tree…");
		expect(render({ tree: undefined, error: "no commits" })).toContain("The tree couldn&#x27;t be read: no commits");
		expect(render({ tree: { ...tree, files: [] }, snapshot: { claims: [], votes: [] } })).toContain("main has no files yet.");
		// Claimed folders on an empty branch still show, as new.
		expect(render({ tree: { ...tree, files: [] } })).toContain('aria-label="docs/ (new): held by agent-b');
	});
});
