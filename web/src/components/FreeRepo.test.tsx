import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { freeSnapshot as snapshot } from "../test/fixtures";
import { FreeAudit, FreeChangeList, FreeChangePage, FreeSettings } from "./FreeRepo";
import { FreeRepoPage } from "./RepoPage";

// A repo in coordinator-free mode, shown like any other repo: its claims as
// open changes, the audit with what's still open and what a revert resolved,
// and the conventions agents follow.

describe("a coordinator-free repo", () => {
	it("shows claims in force as open changes, with head and approvals", () => {
		const html = renderToStaticMarkup(<FreeChangeList snapshot={snapshot} repo="docs-site" base="repos" />);
		expect(html).toContain("Rewrite the C section");
		expect(html).toContain('href="#/repos/docs-site/changes/c-1"');
		expect(html).toContain("src/c/");
		expect(html).toContain("by agent-c");
		expect(html).toContain("1/2 approvals");
		expect(html).toContain("b1c2d3e");
		expect(html).toContain("Changes requested");
		expect(html).toMatch(/3<\/span> merged on main/);
	});

	it("shows the audit, with open and resolved violations apart, and recent reviews", () => {
		const html = renderToStaticMarkup(<FreeAudit snapshot={snapshot} />);
		expect(html).toContain("1 open violation");
		expect(html).toContain("undeclared");
		expect(html).toMatch(/resolved by ee872a3/);
		expect(html).toContain("rev-1");
		expect(html).toContain("suite passes");
		expect(renderToStaticMarkup(<FreeAudit snapshot={{ ...snapshot, audit: { merges: 1, open: 0, violations: [] } }} />)).toMatch(/No violations/);
	});

	it("shows the settings: approvals, vetoes, checks and signed records", () => {
		const html = renderToStaticMarkup(<FreeSettings snapshot={snapshot} />);
		expect(html).toMatch(/2 approvals/);
		expect(html).toContain("security can block");
		expect(html).toContain("npm test");
		expect(html).toMatch(/verified identity/);
		expect(html).toMatch(/own fork/);
	});

	it("shows one claim like a pull request, with its votes and hosted agents", () => {
		const html = renderToStaticMarkup(<FreeChangePage snapshot={snapshot} claim={snapshot.claims[0]} />);
		expect(html).toMatch(/<strong>agent-c<\/strong> wants to merge <code[^>]*>changes\/c-1<\/code>/);
		expect(html).toContain("rev-1</strong> (tests) approved these changes");
		expect(html).toContain("1 of 2 approvals");
		expect(html).toMatch(/Builder working \(revision 1\)/);
		expect(html).toMatch(/security.*reject/);
		const empty = renderToStaticMarkup(<FreeChangePage snapshot={snapshot} claim={{ ...snapshot.claims[0], head: null, hosted: undefined }} />);
		expect(empty).toContain("nothing pushed yet");
	});

	it("has Changes, Audit and Settings tabs, and keeps old #/free links", () => {
		const html = renderToStaticMarkup(<FreeRepoPage repo="docs-site" base="free" view={{ kind: "repo", tab: "audit", state: "open" }} snapshot={snapshot} />);
		expect(html).toContain('href="#/free/docs-site/audit"');
		expect(html).toMatch(/aria-current="page"[^>]*>.*Audit/);
		expect(html).toMatch(/>coordinator-free</);
	});
});
