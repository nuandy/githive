import type { VoteApi } from "./VoteForm";
import type { ChangeHistory, RepoSnapshot } from "../api";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { recordsBadge } from "../lib/claimStatus";
import type { LiveStatus } from "../lib/liveFeed";
import { href, type ChangeTab, type RepoTab } from "../lib/routes";
import { AgentsTab } from "./Agents";
import { ClaimsTab } from "./ClaimsMap";
import { CodeTab, type CodeApi } from "./CodeBrowser";
import { AuditTab, ChangeList, ChangePage, SettingsTab } from "./RepoTabs";
import { RepoHeader } from "./RepoHeader";
import { ShardingBadge } from "./StatusPill";
import type { TabItem } from "./Tabs";

export type RepoView =
	| { kind: "repo"; tab: RepoTab; /** Code tab */ path?: string; ref?: string }
	| { kind: "change"; change: string; tab: ChangeTab };

/** Everything a repo's pages call. The dashboard's api object satisfies it; tests pass stand-ins. */
export type RepoPageApi = CodeApi & VoteApi;

export interface RepoPageProps {
	repo: string;
	view: RepoView;
	snapshot: RepoSnapshot;
	/** On a change page: the change's history (undefined while loading, null if unreadable). */
	changeHistory?: ChangeHistory | null;
	liveStatus?: LiveStatus;
	api: RepoPageApi;
}

/** A repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function RepoPage({ repo, view, snapshot, changeHistory, liveStatus = "off", api }: RepoPageProps) {
	const branch = snapshot.branch ?? "main";
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo), count: snapshot.claims.length },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims") },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "") },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents") },
		{ id: "audit", label: "Audit", icon: "shield", href: href.repo(repo, "audit"), count: snapshot.audit?.open || undefined },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings") },
	];
	const current = view.kind === "change" ? "changes" : view.tab;
	return (
		<>
			<RepoHeader
				name={repo}
				badges={<ShardingBadge summary={recordsBadge(snapshot)} />}
				tabs={tabs}
				current={current}
				homeHref={href.repo(repo)}
				live={liveStatus}
			/>
			<main className="page" id="main">
				{view.kind === "change" ? (
					<ChangePage
						snapshot={snapshot}
						changeId={view.change}
						claim={snapshot.claims.find((c) => c.change === view.change)}
						history={changeHistory}
						repo={repo}
						tab={view.tab}
						api={api}
					/>
				) : current === "audit" ? (
					<AuditTab snapshot={snapshot} />
				) : current === "claims" ? (
					<ClaimsTab repo={repo} branch={branch} holders={holdersFromSnapshot(snapshot, repo)} api={api} />
				) : current === "code" ? (
					<CodeTab repo={repo} path={view.path ?? ""} refParam={view.ref} branch={branch} api={api} />
				) : current === "agents" ? (
					<AgentsTab snapshot={snapshot} />
				) : current === "settings" ? (
					<SettingsTab snapshot={snapshot} />
				) : (
					<ChangeList snapshot={snapshot} repo={repo} />
				)}
			</main>
		</>
	);
}
