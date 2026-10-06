import type { FreeVoteApi } from "./FreeVoteForm";
import type { ReactNode } from "react";
import type { FreeChangeHistory, FreeSnapshot, HistoryEntry, Leader, Live, Task } from "../api";
import { holdersFromSnapshot, holdersFromTask } from "../lib/claimsMap";
import type { LiveStatus } from "../lib/liveFeed";
import { changesOf, isActive, type ChangeState } from "../lib/model";
import { href, type ChangeTab, type RepoBase, type RepoTab } from "../lib/routes";
import { ElectedAgents, FreeAgents } from "./Agents";
import type { ChangeActionsApi } from "./ChangeActions";
import { ChangeList } from "./ChangeList";
import { ChangePage } from "./ChangePage";
import { ClaimsTab } from "./ClaimsMap";
import { CodeTab, type CodeApi } from "./CodeBrowser";
import { FreeAudit, FreeChangeList, FreeChangePage, FreeSettings } from "./FreeRepo";
import { Icon } from "./Icon";
import { Insights } from "./Insights";
import { RepoActivity } from "./RepoActivity";
import { CoordinatorLine, RepoHeader } from "./RepoHeader";
import { RepoSettings, type SettingsApi } from "./RepoSettings";
import type { ReviewFormApi } from "./ReviewForm";
import type { TabItem } from "./Tabs";

export type RepoView =
	| { kind: "repo"; tab: RepoTab; state: ChangeState; /** Code tab */ path?: string; ref?: string }
	| { kind: "change"; change: string; tab: ChangeTab };

/** Everything a repo's pages call. The dashboard's api object satisfies it; tests pass stand-ins. */
export type RepoPageApi = ChangeActionsApi & ReviewFormApi & SettingsApi & CodeApi & FreeVoteApi;

function NotFound({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="box empty">
			<Icon name="alert" size={28} className="muted" />
			<h2>{title}</h2>
			<p>{children}</p>
		</div>
	);
}

export interface ElectedRepoPageProps {
	repo: string;
	base: RepoBase;
	view: RepoView;
	task: Task;
	live?: Live;
	history?: HistoryEntry[] | null;
	leader?: Leader;
	liveStatus?: LiveStatus;
	api: RepoPageApi;
	onChanged(): void;
}

/** A repo run by an elected coordinator: its changes, activity, claims, code, insights, agents and settings, or one change. */
export function ElectedRepoPage({ repo, base, view, task, live, history, leader, liveStatus = "off", api, onChanged }: ElectedRepoPageProps) {
	const changes = changesOf(task);
	const openCount = changes.filter(isActive).length;
	const branch = task.branch ?? "main";
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo, "changes", base), count: openCount },
		{ id: "activity", label: "Activity", icon: "activity", href: href.repo(repo, "activity", base) },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims", base) },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "", base) },
		{ id: "insights", label: "Insights", icon: "activity", href: href.repo(repo, "insights", base) },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents", base) },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings", base) },
	];
	const change = view.kind === "change" ? changes.find((c) => c.id === view.change) : undefined;
	const tab = view.kind === "repo" ? view.tab : "changes";
	return (
		<>
			<RepoHeader
				name={repo}
				mode="elected"
				tabs={tabs}
				current={view.kind === "change" ? "changes" : view.tab}
				homeHref={href.repo(repo, "changes", base)}
				live={liveStatus}
				coordinator={<CoordinatorLine leader={leader} task={task} repo={repo} base={base} />}
			/>
			<main className="page" id="main">
				{view.kind === "change" ? (
					change ? (
						<ChangePage
							task={task}
							change={change}
							agent={live?.agents.find((agent) => agent.id === change.id)}
							history={history}
							repo={repo}
							base={base}
							tab={view.tab}
							api={api}
							onChanged={onChanged}
						/>
					) : (
						<NotFound title="Change not found">
							{repo} has no change named <code>{view.change}</code>. <a href={href.repo(repo, "changes", base)}>See all changes</a>.
						</NotFound>
					)
				) : tab === "activity" ? (
					<RepoActivity task={task} repo={repo} base={base} history={history} />
				) : tab === "claims" ? (
					<ClaimsTab repo={repo} branch={branch} holders={holdersFromTask(task, repo, base)} api={api} />
				) : tab === "code" ? (
					<CodeTab repo={repo} base={base} path={view.kind === "repo" ? (view.path ?? "") : ""} refParam={view.kind === "repo" ? view.ref : undefined} branch={branch} api={api} />
				) : tab === "insights" ? (
					<Insights task={task} history={history} />
				) : tab === "agents" ? (
					<ElectedAgents task={task} />
				) : tab === "settings" ? (
					<RepoSettings task={task} api={api} onSaved={onChanged} />
				) : tab === "audit" ? (
					<NotFound title="No audit here">The audit belongs to coordinator-free repos; this repo's coordinator enforces the rules as changes merge.</NotFound>
				) : (
					<ChangeList task={task} repo={repo} base={base} state={view.kind === "repo" ? view.state : "open"} />
				)}
			</main>
		</>
	);
}

export interface FreeRepoPageProps {
	repo: string;
	base: RepoBase;
	view: RepoView;
	snapshot: FreeSnapshot;
	/** On a change page: the change's history (undefined while loading, null if unreadable). */
	changeHistory?: FreeChangeHistory | null;
	liveStatus?: LiveStatus;
	api: CodeApi & FreeVoteApi;
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
	const current = view.kind === "change" ? "changes" : view.tab === "activity" || view.tab === "insights" ? "audit" : view.tab;
	return (
		<>
			<RepoHeader name={repo} mode="coordinator-free" tabs={tabs} current={current} homeHref={href.repo(repo, "changes", base)} live={liveStatus} />
			<main className="page" id="main">
				{view.kind === "change" ? (
					<FreeChangePage
						snapshot={snapshot}
						changeId={view.change}
						claim={snapshot.claims.find((c) => c.change === view.change)}
						history={changeHistory}
						repo={repo}
						base={base}
						tab={view.tab === "commits" ? "commits" : "conversation"}
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
