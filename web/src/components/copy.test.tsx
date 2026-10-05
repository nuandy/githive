import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Live } from "../api";
import { buildRepoRows } from "../lib/repos";
import { agentState, ago, approve, freeSnapshot, makeChange, makeTask, reject, visibleText } from "../test/fixtures";
import type { ChangeActionsApi } from "./ChangeActions";
import { ElectedRepoPage, FreeRepoPage } from "./RepoPage";
import { RepoList } from "./RepoList";

// People see changes, claims, checks, reviews and repos: never the internal
// slices, lanes, tasks, leases, gates, quorums or the Merge-ahead matrix.

const FORBIDDEN = /\b(slices?|lanes?|tasks?|leases?|gates?|quorums?|merge-ahead|matrix|integrat\w*|human)\b/i;

const api: ChangeActionsApi = {
	waive: vi.fn(),
	messageBuilder: vi.fn(),
	retryChecks: vi.fn(),
	abandon: vi.fn(),
	sliceDiff: vi.fn(),
} as unknown as ChangeActionsApi;

const change = makeChange({
	external: false,
	openedAt: ago(60),
	head: "h2",
	touched: ["src/stats/a.ts", "README.md"],
	outOfLane: ["README.md"],
	reviewHead: "h1",
	revisions: 1,
	sentBackFor: "h1",
	lastFeedback: "Review sent your slice back (quorum rejected).",
	reviews: [approve("tests", "h1"), reject("security", "h1")],
	gate: { status: "waiting", head: "h1", baseHead: "b", at: ago(2), excluded: ["test/other.test.ts"], result: { passed: false, head: "h1", baseHead: "b", results: [{ command: "npm test", exitCode: 1, output: "fail" }], at: ago(2) } },
	leaseUntil: new Date(Date.now() + 20 * 60_000).toISOString(),
});
const task = makeTask({
	slices: [change, makeChange({ id: "other", title: "Other", attention: "Stuck" }), makeChange({ id: "done", status: "integrated" })],
	checks: [{ pair: ["add-stats", "other"], heads: ["a", "b"], status: "conflict", files: ["x.ts"], checkedAt: ago(1) }],
	laneChangeRequests: [{ id: "r1", requester: "add-stats", owner: "other", path: "src/x.ts", need: "Export x", reason: "Needed", status: "human", createdAt: ago(3) }],
});
const live: Live = {
	task,
	agents: [{ id: "add-stats", builder: agentState({ status: "working", log: [{ at: ago(1), event: "sent back (revision 1): Review sent your slice back" }] }), reviewers: [{ role: "tests", state: agentState({ status: "working" }) }] }],
};
const history = [
	{ at: ago(60), text: "Change add-stats opened by service token abc", commit: "s" },
	{ at: ago(10), text: "add-stats sent back to its builder (revision 1 of 3):\n- security (veto) rejected: slice leaks", commit: "h1" },
	{ at: ago(5), text: "Cross-lane request r1 from add-stats to integrated slice other needs a human", commit: "h1" },
	{ at: ago(2), text: "add-stats: waiting for other slices to integrate before the gate re-runs", commit: "h1" },
];

function words(html: string) {
	const text = visibleText(html);
	const match = FORBIDDEN.exec(text);
	return match ? text.slice(Math.max(0, match.index - 60), match.index + 60) : null;
}

describe("dashboard copy", () => {
	it("uses people's words on every page", () => {
		const pages = [
			<RepoList rows={buildRepoRows([task], [{ repo: "docs-site", since: ago(1) }], { "docs-site": freeSnapshot })} loaded allRepos={[]} opening={false} onOpenRepo={() => undefined} />,
			<RepoList rows={[]} loaded allRepos={[]} opening={false} onOpenRepo={() => undefined} />,
			...(["open", "merged", "abandoned"] as const).map((state) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "changes", state }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			...(["activity", "settings"] as const).map((tab) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab, state: "open" }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			<ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "activity", state: "open" }} task={task} history={null} api={api} onChanged={() => undefined} />,
			...(["conversation", "files", "checks"] as const).flatMap((tab) =>
				["add-stats", "other", "done"].map((id) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "change", change: id, tab }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			),
			...(["changes", "audit", "settings"] as const).map((tab) => <FreeRepoPage repo="docs-site" base="repos" view={{ kind: "repo", tab, state: "open" }} snapshot={freeSnapshot} />),
			<FreeRepoPage repo="docs-site" base="repos" view={{ kind: "change", change: "c-1", tab: "conversation" }} snapshot={freeSnapshot} />,
		];
		for (const page of pages) expect(words(renderToStaticMarkup(page))).toBeNull();
	});
});
