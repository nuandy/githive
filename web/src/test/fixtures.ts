import type { RepoSnapshot } from "../api";

// Small builders for dashboard tests: a repo and one of its changes.

export const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export const repoSnapshot: RepoSnapshot = {
	repo: "acme/docs-site",
	policy: { required: 2, vetoes: ["security"] },
	verify: ["npm test"],
	verified: true,
	claims: [
		{
			change: "c-1",
			agent: "agent-c",
			paths: ["src/c/"],
			intent: "Rewrite the C section",
			since: ago(120),
			active: ago(5),
			by: "service:abc/agent-c",
			head: "b1c2d3e4f5a6",
			approval: { approved: false, approvals: 1, required: 2, vetoedBy: [] },
			hosted: { builder: { status: "working", revisions: 1 }, reviewers: [{ role: "security", status: "done", verdict: "reject" }] },
		},
	],
	votes: [{ commit: "b1c2d3e4f5a6", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "suite passes", at: ago(20), by: "service:rev-1" }],
	audit: {
		merges: 3,
		open: 1,
		violations: [
			{ commit: "e7b6bf97aaaa", author: "agent-b", rule: "inside-another-claim", detail: "src/c/z.txt was claimed by c-1 (agent-c) at c8f1529b", resolvedBy: "ee872a30bbbb" },
			{ commit: "41664f1dcccc", author: "agent-b-rogue", rule: "undeclared", detail: "the merge names no change or claims it checked" },
		],
	},
};

/** Visible text of rendered markup, for checking the words people see. */
export function visibleText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&[a-z#0-9]+;/gi, " ")
		.replace(/\s+/g, " ");
}

/** A stand-in for every call a repo page makes; each resolves to a harmless value. */
export function stubApi(): import("../components/RepoPage").RepoPageApi {
	return {
		tree: async () => ({ ref: "main", commit: "c0ffee", files: [], truncated: false }),
		file: async (_repo: string, path: string) => ({ ref: "main", commit: "c0ffee", path, size: 0, text: "" }),
		vote: async () => ({}),
	};
}

/** A change's history: claimed, two commits, a vote, still in force. */
export const historyFixture: import("../api").ChangeHistory = {
	change: "c-1",
	branch: "main",
	claim: { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "Rewrite the C section", since: ago(120), active: ago(5), by: "service:abc/agent-c" },
	released: [],
	commits: [
		{ commit: "b1c2d3e4f5a6", message: "Tighten the wording\n\nAnd fix two links.", author: "agent-c", at: ago(30) },
		{ commit: "a0a0a0a0a0a0", message: "First draft of section C", author: "agent-c", at: ago(90) },
	],
	votes: [{ commit: "b1c2d3e4f5a6", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "suite passes", at: ago(20), by: "service:rev-1" }],
};
