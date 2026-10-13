import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { ago, repoSnapshot, visibleText } from "../test/fixtures";
import { Overview } from "./Overview";
import { Territory } from "./Territory";

// The Changes tab's sentence and its Territory: each claim lit in its change's state, with the glyphs and words it has
// everywhere, and what needs a person counted as the Hive and the Inbox count it.

type Claim = RepoSnapshot["claims"][number];

const claim = (change: string, paths: string[], over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths,
	intent: change,
	since: ago(10),
	active: ago(1),
	head: `${change}-head`,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const policy = { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } };
const claims = [
	claim("asks", ["lib/asks.js"], { attention: { reason: "which cache?", agent: "agent-asks", at: ago(1) } }),
	claim("votes", ["lib/votes.js"], {
		approval: { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] },
	}),
	claim("ok", ["lib/ok.js"], { approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] } }),
];
const snapshot = { ...repoSnapshot, policy, claims, votes: [] };
const tree = { ref: "main", commit: "c0ffee", files: ["lib/asks.js", "lib/votes.js", "lib/ok.js"], truncated: false };

describe("the territory", () => {
	it("keys every state in its own words, red and green told apart by their glyphs", () => {
		const html = renderToStaticMarkup(<Territory repo="acme/web" branch="main" snapshot={snapshot} tree={tree} />);
		const legend = visibleText(html.slice(html.indexOf("What the lamps mean"), html.indexOf("</ul>")));
		expect(legend).toContain(
			"! needs a person × changes requested × checks failed abandoned, free to take ● landing ✓ approved in review building not claimed",
		);
		expect(html).toContain('title="lib/votes.js: votes by agent-votes, needs a person"');
		expect(html).toContain('title="lib/ok.js: ok by agent-ok, approved"');
		// Amber is only for what's being checked to land.
		expect(html).not.toMatch(/data-state="(in-review|building)"[^>]*\bamber\b/);
	});
});

describe("the Changes tab's sentence", () => {
	it("counts what needs a person as the Hive does: questions, votes only people give, and the audit", () => {
		const api = { tree: async () => tree };
		const text = visibleText(
			renderToStaticMarkup(<Overview repo="acme/web" branch="main" snapshot={snapshot} api={api} />),
		);
		expect(text).toContain("3 claims in force ! 2 need a person ✓ 1 approved ! 1 merge for the audit to look at");
	});
});
