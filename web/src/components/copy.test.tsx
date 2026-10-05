import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Live } from "../api";
import { buildRepoRows } from "../lib/repos";
import { agentState, ago, approve, freeHistory, freeSnapshot, makeChange, makeTask, reject, stubApi, visibleText } from "../test/fixtures";
import { buildInbox } from "../lib/inbox";
import { holdersFromSnapshot, holdersFromTask } from "../lib/claimsMap";
import { ClaimsMap } from "./ClaimsMap";
import { CodeView } from "./CodeBrowser";
import { InboxPage } from "./InboxPage";
import { CoordinatorLine } from "./RepoHeader";
import { TopBar } from "./TopBar";
import { ElectedRepoPage, FreeRepoPage } from "./RepoPage";
import { RepoList } from "./RepoList";

// People see changes, claims, checks, reviews and repos: never the internal
// slices, lanes, tasks, leases, gates, quorums or the Merge-ahead matrix.

const FORBIDDEN = /\b(slices?|lanes?|tasks?|leases?|gates?|quorums?|merge-ahead|matrix|integrat\w*|human)\b/i;

const api = stubApi();

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
const inReview = makeChange({
	id: "in-review",
	title: "In review",
	reviewHead: "r1",
	reviews: [{ ...approve("tests", "r1"), usage: { inputTokens: 1200, outputTokens: 300 } }, { ...reject("security", "r1"), by: "agent:sec-bot" }],
	pushes: [
		{ head: "r0", at: ago(40), files: 2, outOfLane: 1, conflicts: 1 },
		{ head: "r1", at: ago(20), files: 3, outOfLane: 0, conflicts: 0 },
	],
	openedAt: ago(50),
	openedBy: "agent:agent-a",
});
const task = makeTask({
	agents: { "agent-a": { keyHash: "k", at: ago(500), by: "person:abc123" } },
	review: { reviewers: ["tests", "security"], required: 2, vetoes: ["security"], external: ["tests"], escalate: [{ paths: ["package.json"], reviewers: ["supply-chain"], vetoes: ["supply-chain"] }] },
	slices: [change, inReview, makeChange({ id: "other", title: "Other", attention: "Stuck" }), makeChange({ id: "done", status: "integrated", openedAt: ago(90), endedAt: ago(30) })],
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
			<RepoList rows={buildRepoRows({ tasks: [{ id: task.id, repo: task.repo, createdAt: task.createdAt, elected: true, summary: { open: 2, needsYou: 1, countedAt: ago(1) } }], free: [{ repo: "docs-site", since: ago(1), summary: { open: 1, violations: 1, countedAt: ago(1) } }] })} loaded allRepos={[]} opening={false} onOpenRepo={() => undefined} />,
			<RepoList rows={[]} loaded allRepos={[]} opening={false} onOpenRepo={() => undefined} />,
			...(["open", "merged", "abandoned"] as const).map((state) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "changes", state }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			...(["activity", "claims", "code", "insights", "agents", "settings"] as const).map((tab) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab, state: "open" }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			<ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "activity", state: "open" }} task={task} history={null} api={api} onChanged={() => undefined} />,
			...(["conversation", "commits", "files", "checks"] as const).flatMap((tab) =>
				["add-stats", "in-review", "other", "done"].map((id) => <ElectedRepoPage repo="my-app" base="repos" view={{ kind: "change", change: id, tab }} task={task} live={live} history={history} api={api} onChanged={() => undefined} />),
			),
			...(["changes", "claims", "code", "agents", "audit", "settings"] as const).map((tab) => <FreeRepoPage repo="docs-site" base="repos" view={{ kind: "repo", tab, state: "open" }} snapshot={freeSnapshot} api={api} />),
			<FreeRepoPage repo="docs-site" base="repos" view={{ kind: "change", change: "c-1", tab: "conversation" }} snapshot={freeSnapshot} api={api} />,
			...(["conversation", "commits"] as const).flatMap((tab) => [
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "c-1", tab }} snapshot={freeSnapshot} changeHistory={freeHistory} liveStatus="reconnecting" api={api} />,
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "gone", tab }} snapshot={freeSnapshot} changeHistory={{ ...freeHistory, change: "gone", claim: null, released: [{ reason: "merged", at: ago(1), mergedAs: "ffee0011", agent: "agent-c" }] }} api={api} />,
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "old", tab }} snapshot={freeSnapshot} changeHistory={{ ...freeHistory, change: "old", claim: null, released: [{ reason: "claim expired", at: ago(1), agent: "agent-c", stale: true }] }} api={api} />,
			]),
			<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "nope", tab: "conversation" }} snapshot={freeSnapshot} changeHistory={null} api={api} />,
			<ElectedRepoPage repo="my-app" base="repos" view={{ kind: "repo", tab: "changes", state: "open" }} task={task} live={live} history={history} leader={{ leader: `${task.id}--in-review`, term: 2 }} liveStatus="live" api={api} onChanged={() => undefined} />,
			<CoordinatorLine leader={{ leader: null, term: 0 }} task={task} repo="my-app" base="repos" />,
			<TopBar crumbs={[{ label: "Inbox" }]} inboxCount={2} inboxCurrent />,
			<InboxPage
				groups={buildInbox({ tasks: [{ id: task.id, repo: "my-app", createdAt: ago(5), elected: true, summary: { waiting: [{ change: "other", title: "Other", reason: "Reviewers disagree" }] } }], free: [{ repo: "docs-site", since: ago(5), summary: { waiting: [{ change: "c-1", title: "", reason: "Blueprint's builder failed" }] } }] }).groups}
				loaded
			/>,
			<InboxPage groups={[]} loaded />,
			<ClaimsMap branch="main" holders={holdersFromTask(task, "my-app")} tree={{ ref: "main", commit: "c", files: ["src/stats/a.ts", "README.md", "x.ts", "lib/util.ts"], truncated: true }} />,
			<ClaimsMap branch="main" holders={holdersFromSnapshot(freeSnapshot, "docs-site")} tree={{ ref: "main", commit: "c", files: ["src/c/a.md"], truncated: false }} />,
			<CodeView repo="my-app" base="repos" path="" branch="main" tree={{ ref: "main", commit: "c", files: ["src/a.ts", "logo.png"], truncated: true }} />,
			<CodeView repo="my-app" base="repos" path="src/a.ts" refParam="abcdef123" branch="main" tree={{ ref: "abcdef123", commit: "abcdef123", files: ["src/a.ts"], truncated: false }} file={{ ref: "abcdef123", commit: "abcdef123", path: "src/a.ts", size: 10, text: "export {};\n" }} />,
			<CodeView repo="my-app" base="repos" path="logo.png" branch="main" tree={{ ref: "main", commit: "c", files: ["logo.png"], truncated: false }} file={{ ref: "main", commit: "c", path: "logo.png", size: 10, binary: true }} />,
		];
		for (const page of pages) expect(words(renderToStaticMarkup(page))).toBeNull();
	});
});
