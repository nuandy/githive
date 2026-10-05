import type { FreeSnapshot, Live, Task } from "../api";
import type { Change } from "../lib/model";

// Small builders for dashboard tests: a repo (an open-mode task) and its changes.

export const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export function makeChange(overrides: Partial<Change> = {}): Change {
	return {
		id: "add-stats",
		title: "Add stats page",
		owns: ["src/stats/"],
		instructions: "",
		intent: "Add a stats page that shows weekly totals.",
		status: "building",
		touched: [],
		outOfLane: [],
		reviews: [],
		...overrides,
	} as Change;
}

export function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "open-my-app",
		repo: "my-app",
		goal: "Open changes on my-app",
		phase: "building",
		mode: "open",
		leaseMinutes: 30,
		verify: ["npm test"],
		review: { reviewers: ["tests", "security"], required: 2, vetoes: ["security"] },
		slices: [],
		checks: [],
		limits: { builders: 4, reviewers: 6 },
		queue: [],
		active: { builders: [], reviewers: [] },
		createdAt: ago(60 * 24),
		laneChangeRequests: [],
		...overrides,
	} as Task;
}

export const approve = (reviewer: string, head: string, at = ago(10), summary = "Looks good") => ({ reviewer, head, verdict: "approve" as const, summary, at });
export const reject = (reviewer: string, head: string, at = ago(10), summary = "Needs work") => ({ reviewer, head, verdict: "reject" as const, summary, at });

export function agentState(overrides: Partial<NonNullable<Live["agents"][number]["builder"]>> = {}) {
	return {
		status: "working" as const,
		startedAt: ago(60),
		turns: 1,
		toolCalls: 1,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
		log: [],
		...overrides,
	};
}

export const freeSnapshot: FreeSnapshot = {
	repo: "docs-site",
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
