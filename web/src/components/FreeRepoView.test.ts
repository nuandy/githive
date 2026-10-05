import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FreeSnapshot } from "../api";
import { FreeRepoList, FreeRepoView } from "./FreeRepoView";

// A repo in coordinator-free mode on the dashboard: its settings, the claims in
// force, recent votes, and the audit, with what's still open and what a revert
// resolved.

const snapshot: FreeSnapshot = {
	repo: "free-demo",
	policy: { required: 2, vetoes: ["security"] },
	verify: ["npm test"],
	verified: true,
	claims: [
		{
			change: "c-1",
			agent: "agent-c",
			paths: ["src/c/"],
			intent: "c's work",
			since: "2026-10-05T10:00:00.000Z",
			active: "2026-10-05T10:00:00.000Z",
			by: "service:agent-c",
			head: "b1c2d3e4f5a6",
			approval: { approved: false, approvals: 1, required: 2, vetoedBy: [] },
			hosted: { builder: { status: "working", revisions: 1 }, reviewers: [{ role: "security", status: "done", verdict: "reject" }] },
		},
	],
	votes: [{ commit: "a9d4e88bd01e905b", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok", at: "2026-10-05T10:01:00.000Z", by: "service:rev-1" }],
	audit: {
		merges: 3,
		open: 1,
		violations: [
			{ commit: "e7b6bf97aaaa", author: "agent-b", rule: "inside-another-claim", detail: "src/c/z.txt was claimed by c-1 (agent-c) at c8f1529b", resolvedBy: "ee872a30bbbb" },
			{ commit: "41664f1dcccc", author: "agent-b-rogue", rule: "undeclared", detail: "the merge names no change or claims it checked" },
		],
	},
};

describe("the coordinator-free view", () => {
	it("shows the settings, claims, votes and the audit, with open and resolved violations apart", () => {
		const html = renderToStaticMarkup(createElement(FreeRepoView, { snapshot }));
		expect(html).toContain("free-demo");
		expect(html).toMatch(/2 approvals/);
		expect(html).toContain("security");
		expect(html).toContain("npm test");
		expect(html).toMatch(/verified/i);
		expect(html).toContain("src/c/");
		expect(html).toContain("service:agent-c");
		expect(html).toContain("rev-1");
		expect(html).toMatch(/1 open/);
		expect(html).toContain("undeclared");
		expect(html).toMatch(/resolved by ee872a30/);
	});

	it("shows where each claimed change stands: its head, approvals, and Blueprint's agents on it", () => {
		const html = renderToStaticMarkup(createElement(FreeRepoView, { snapshot }));
		expect(html).toContain("b1c2d3e4");
		expect(html).toMatch(/1 of 2 approvals/);
		expect(html).toMatch(/builder working \(revision 1\)/);
		expect(html).toMatch(/security: reject/);
		expect(html).toMatch(/own fork/);
	});

	it("says when a claimed change has nothing pushed yet", () => {
		const html = renderToStaticMarkup(createElement(FreeRepoView, { snapshot: { ...snapshot, claims: [{ ...snapshot.claims[0], head: null, hosted: undefined }] } }));
		expect(html).toMatch(/nothing pushed yet/);
	});

	it("says so when the audit finds nothing", () => {
		const html = renderToStaticMarkup(createElement(FreeRepoView, { snapshot: { ...snapshot, audit: { merges: 1, open: 0, violations: [] } } }));
		expect(html).toMatch(/no violations/i);
	});

	it("lists repos in the mode as links to their view", () => {
		const html = renderToStaticMarkup(createElement(FreeRepoList, { repos: [{ repo: "free-demo", since: "" }], selected: "free-demo" }));
		expect(html).toContain('href="#/free/free-demo"');
		expect(html).toContain('aria-current="page"');
	});
});
