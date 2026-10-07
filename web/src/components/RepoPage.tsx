import type { FreeVoteApi } from "./FreeVoteForm";
import type { FreeChangeHistory, FreeSnapshot } from "../api";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { recordsBadge } from "../lib/freeStatus";
import type { LiveStatus } from "../lib/liveFeed";
import { href, type ChangeTab, type RepoBase, type RepoTab } from "../lib/routes";
import { FreeAgents } from "./Agents";
import { ClaimsTab } from "./ClaimsMap";
import { CodeTab, type CodeApi } from "./CodeBrowser";
import { FreeAudit, FreeChangeList, FreeChangePage, FreeSettings } from "./FreeRepo";
import { RepoHeader } from "./RepoHeader";
import { ShardingBadge } from "./StatusPill";
import type { TabItem } from "./Tabs";

export type RepoView =
	| { kind: "repo"; tab: RepoTab; /** Code tab */ path?: string; ref?: string }
	| { kind: "change"; change: string; tab: ChangeTab };

/** Everything a repo's pages call. The dashboard's api object satisfies it; tests pass stand-ins. */
export type RepoPageApi = CodeApi & FreeVoteApi;

export interface FreeRepoPageProps {
	repo: string;
	base: RepoBase;
	view: RepoView;
	snapshot: FreeSnapshot;
	/** On a change page: the change's history (undefined while loading, null if unreadable). */
	changeHistory?: FreeChangeHistory | null;
	liveStatus?: LiveStatus;
	api: RepoPageApi;
}

/** A coordinator-free repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function FreeRepoPage({ repo, base, view, snapshot, changeHistory, liveStatus = "off", api }: FreeRepoPageProps) {
	const branch = snapshot.branch ?? "main";
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo, "changes", base), count: snapshot.claims.length },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims", base) },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "", base) },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents", base) },
		{ id: "audit", label: "Audit", icon: "shield", href: href.repo(repo, "audit", base), count: snapshot.audit?.open || undefined },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings", base) },
	];
	const current = view.kind === "change" ? "changes" : view.tab;
	return (
		<>
			<RepoHeader
				name={repo}
				badges={<ShardingBadge summary={recordsBadge(snapshot)} />}
				tabs={tabs}
				current={current}
				homeHref={href.repo(repo, "changes", base)}
				live={liveStatus}
			/>
			<main className="page" id="main">
				{view.kind === "change" ? (
					<FreeChangePage
						snapshot={snapshot}
						changeId={view.change}
						claim={snapshot.claims.find((c) => c.change === view.change)}
						history={changeHistory}
						repo={repo}
						base={base}
						tab={view.tab}
						api={api}
					/>
				) : current === "audit" ? (
					<FreeAudit snapshot={snapshot} />
				) : current === "claims" ? (
					<ClaimsTab repo={repo} branch={branch} holders={holdersFromSnapshot(snapshot, repo, base)} api={api} />
				) : current === "code" ? (
					<CodeTab repo={repo} base={base} path={view.path ?? ""} refParam={view.ref} branch={branch} api={api} />
				) : current === "agents" ? (
					<FreeAgents snapshot={snapshot} />
				) : current === "settings" ? (
					<FreeSettings snapshot={snapshot} />
				) : (
					<FreeChangeList snapshot={snapshot} repo={repo} base={base} />
				)}
			</main>
		</>
	);
}
