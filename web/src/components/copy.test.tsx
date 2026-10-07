import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRepoRows } from "../lib/repos";
import { ago, freeHistory, freeSnapshot, stubApi, visibleText } from "../test/fixtures";
import { buildInbox } from "../lib/inbox";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { ClaimsMap } from "./ClaimsMap";
import { CodeView } from "./CodeBrowser";
import { InboxPage } from "./InboxPage";
import { TopBar } from "./TopBar";
import { FreeRepoPage } from "./RepoPage";
import { RepoList } from "./RepoList";

// People see changes, claims, checks, reviews and repos: never the internal
// slices, lanes, tasks, leases, gates, quorums or the Merge-ahead matrix.

const FORBIDDEN = /\b(slices?|lanes?|tasks?|leases?|gates?|quorums?|merge-ahead|matrix|integrat\w*|human)\b/i;

const api = stubApi();

function words(html: string) {
	const text = visibleText(html);
	const match = FORBIDDEN.exec(text);
	return match ? text.slice(Math.max(0, match.index - 60), match.index + 60) : null;
}

describe("dashboard copy", () => {
	it("uses people's words on every page", () => {
		const pages = [
			<RepoList rows={buildRepoRows({ free: [{ repo: "docs-site", since: ago(1), summary: { open: 1, needsYou: 1, violations: 1, countedAt: ago(1) } }] })} loaded />,
			<RepoList rows={[]} loaded />,
			...(["changes", "claims", "code", "agents", "audit", "settings"] as const).map((tab) => <FreeRepoPage repo="docs-site" base="repos" view={{ kind: "repo", tab }} snapshot={freeSnapshot} api={api} />),
			<FreeRepoPage repo="docs-site" base="repos" view={{ kind: "change", change: "c-1", tab: "conversation" }} snapshot={freeSnapshot} api={api} />,
			...(["conversation", "commits"] as const).flatMap((tab) => [
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "c-1", tab }} snapshot={freeSnapshot} changeHistory={freeHistory} liveStatus="reconnecting" api={api} />,
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "gone", tab }} snapshot={freeSnapshot} changeHistory={{ ...freeHistory, change: "gone", claim: null, released: [{ reason: "merged", at: ago(1), mergedAs: "ffee0011", agent: "agent-c" }] }} api={api} />,
				<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "old", tab }} snapshot={freeSnapshot} changeHistory={{ ...freeHistory, change: "old", claim: null, released: [{ reason: "claim expired", at: ago(1), agent: "agent-c", stale: true }] }} api={api} />,
			]),
			<FreeRepoPage repo="docs-site" base="free" view={{ kind: "change", change: "nope", tab: "conversation" }} snapshot={freeSnapshot} changeHistory={null} api={api} />,
			<TopBar crumbs={[{ label: "Inbox" }]} inboxCount={2} inboxCurrent />,
			<InboxPage groups={buildInbox({ free: [{ repo: "docs-site", since: ago(5), summary: { waiting: [{ change: "c-1", title: "", reason: "Blueprint's builder failed" }] } }] }).groups} loaded />,
			<InboxPage groups={[]} loaded />,
			<ClaimsMap branch="main" holders={holdersFromSnapshot(freeSnapshot, "docs-site")} tree={{ ref: "main", commit: "c", files: ["src/c/a.md"], truncated: false }} />,
			<CodeView repo="my-app" base="repos" path="" branch="main" tree={{ ref: "main", commit: "c", files: ["src/a.ts", "logo.png"], truncated: true }} />,
			<CodeView repo="my-app" base="repos" path="src/a.ts" refParam="abcdef123" branch="main" tree={{ ref: "abcdef123", commit: "abcdef123", files: ["src/a.ts"], truncated: false }} file={{ ref: "abcdef123", commit: "abcdef123", path: "src/a.ts", size: 10, text: "export {};\n" }} />,
			<CodeView repo="my-app" base="repos" path="logo.png" branch="main" tree={{ ref: "main", commit: "c", files: ["logo.png"], truncated: false }} file={{ ref: "main", commit: "c", path: "logo.png", size: 10, binary: true }} />,
		];
		for (const page of pages) expect(words(renderToStaticMarkup(page))).toBeNull();
	});
});
