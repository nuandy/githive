import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { Overview } from "./Overview";
import { ChangeLabels, ChangeList } from "./RepoTabs";

// The overview shows one branch at a time, picked from those changes land
// on; a change says where it lands and what holds it back.

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, over: Partial<Claim> = {}): Claim => ({
	change,
	agent: "agent-a",
	paths: [`src/${change}/`],
	intent: `do ${change}`,
	since: new Date().toISOString(),
	active: new Date().toISOString(),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const snapshot: RepoSnapshot = {
	repo: "acme/web",
	policy: { required: 1, vetoes: [] },
	verify: [],
	branch: "main",
	verified: true,
	branches: [{ name: "feature/checkout", base: "a".repeat(40), from: "main", at: "" }],
	claims: [
		claim("on-main"),
		claim("on-feature", { into: "feature/checkout" }),
		claim("another-feature", { into: "feature/checkout" }),
	],
	votes: [],
};
const api = {
	tree: async () => ({ ref: "main", commit: "c", files: [], truncated: false }),
	landing: async () => ({ branch: "main", checking: null, recent: [] }),
	makeBranch: async () => ({ name: "x" }),
};

describe("the overview of one branch", () => {
	it("offers every branch changes land on, and counts only the claims on the one shown", () => {
		const html = renderToStaticMarkup(
			<Overview repo="acme/web" branch="main" shown="feature/checkout" snapshot={snapshot} api={api} canWrite />,
		);
		expect(html).toContain('<option value="main">main (project)</option>');
		expect(html).toMatch(/<option value="feature\/checkout" selected="">feature\/checkout<\/option>/);
		expect(html).toContain("New branch");
		const list = renderToStaticMarkup(<ChangeList repo="acme/web" shown="feature/checkout" snapshot={snapshot} />);
		expect(list).toMatch(/<span>2<\/span> Open/);
		expect(list).not.toContain("do on-main");
	});

	it("shows the project's branch for a branch nothing lands on, and says so", () => {
		const html = renderToStaticMarkup(
			<Overview repo="acme/web" branch="main" shown="feature/gone" snapshot={snapshot} api={api} />,
		);
		expect(html).toContain("There&#x27;s no branch feature/gone taking changes here: showing main.");
		expect(html).not.toContain("New branch");
	});
});

describe("a change's labels", () => {
	it("say where it lands, which branch it merges, and what it waits on", () => {
		const html = renderToStaticMarkup(
			<ChangeLabels claim={{ into: "main", source: "feature/checkout", waitsOn: ["api"] }} />,
		);
		expect(html).toContain("merges <code>feature/checkout</code>");
		expect(html).toContain("into <code>main</code>");
		expect(html).toContain("waits on api");
		expect(renderToStaticMarkup(<ChangeLabels claim={{}} />)).toBe("");
	});
});
