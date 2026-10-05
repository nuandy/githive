import type { ReactNode } from "react";
import type { FreeSnapshot, HistoryEntry, Live, Task } from "../api";
import { changesOf, isActive } from "../lib/model";
import { href, type ChangeTab, type RepoBase, type RepoTab } from "../lib/routes";
import type { ChangeState } from "../lib/model";
import { ChangeList } from "./ChangeList";
import { ChangePage } from "./ChangePage";
import type { ChangeActionsApi } from "./ChangeActions";
import { FreeAudit, FreeChangeList, FreeChangePage, FreeSettings } from "./FreeRepo";
import { Icon } from "./Icon";
import { RepoActivity } from "./RepoActivity";
import { RepoHeader } from "./RepoHeader";
import { RepoSettings } from "./RepoSettings";
import type { TabItem } from "./Tabs";

export type RepoView = { kind: "repo"; tab: RepoTab; state: ChangeState } | { kind: "change"; change: string; tab: ChangeTab };

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
	api: ChangeActionsApi;
	onChanged(): void;
}

/** A repo run by an elected coordinator: its changes, activity and settings, or one change. */
export function ElectedRepoPage({ repo, base, view, task, live, history, api, onChanged }: ElectedRepoPageProps) {
	const changes = changesOf(task);
	const openCount = changes.filter(isActive).length;
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo, "changes", base), count: openCount },
		{ id: "activity", label: "Activity", icon: "activity", href: href.repo(repo, "activity", base) },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings", base) },
	];
	const change = view.kind === "change" ? changes.find((c) => c.id === view.change) : undefined;
	return (
		<>
			<RepoHeader name={repo} mode="elected" tabs={tabs} current={view.kind === "change" ? "changes" : view.tab} homeHref={href.repo(repo, "changes", base)} />
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
				) : view.tab === "activity" ? (
					<RepoActivity task={task} repo={repo} base={base} history={history} />
				) : view.tab === "settings" ? (
					<RepoSettings task={task} />
				) : view.tab === "audit" ? (
					<NotFound title="No audit here">The audit belongs to coordinator-free repos; this repo's coordinator enforces the rules as changes merge.</NotFound>
				) : (
					<ChangeList task={task} repo={repo} base={base} state={view.state} />
				)}
			</main>
		</>
	);
}

/** A coordinator-free repo: claims in force as its changes, its audit and settings, or one change. */
export function FreeRepoPage({ repo, base, view, snapshot }: { repo: string; base: RepoBase; view: RepoView; snapshot: FreeSnapshot }) {
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo, "changes", base), count: snapshot.claims.length },
		{ id: "audit", label: "Audit", icon: "shield", href: href.repo(repo, "audit", base), count: snapshot.audit?.open || undefined },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings", base) },
	];
	const claim = view.kind === "change" ? snapshot.claims.find((c) => c.change === view.change) : undefined;
	const current = view.kind === "change" ? "changes" : view.tab === "activity" ? "audit" : view.tab;
	return (
		<>
			<RepoHeader name={repo} mode="coordinator-free" tabs={tabs} current={current} homeHref={href.repo(repo, "changes", base)} />
			<main className="page" id="main">
				{view.kind === "change" ? (
					claim ? (
						<FreeChangePage snapshot={snapshot} claim={claim} />
					) : (
						<NotFound title="Change not found">
							No claim named <code>{view.change}</code> is in force in {repo}; it may have merged or been released. <a href={href.repo(repo, "changes", base)}>See open changes</a>.
						</NotFound>
					)
				) : current === "audit" ? (
					<FreeAudit snapshot={snapshot} />
				) : current === "settings" ? (
					<FreeSettings snapshot={snapshot} />
				) : (
					<FreeChangeList snapshot={snapshot} repo={repo} base={base} />
				)}
			</main>
		</>
	);
}
