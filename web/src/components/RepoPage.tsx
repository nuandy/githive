import { useState } from "react";
import "./RepoPage.css";
import type { VoteApi } from "./VoteForm";
import type { ChangeHistory, RepoAccess, RepoSnapshot } from "../api";
import { canVote } from "../lib/permissions";
import { messageOf } from "./Confirm";
import { RepoAdmin, type RepoManageApi } from "./RepoAdmin";
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
	/** Its claims and votes; null when GitHive hasn't started on it yet (its code and settings still show). */
	snapshot: RepoSnapshot | null;
	/** On a change page: the change's history (undefined while loading, null if unreadable). */
	changeHistory?: ChangeHistory | null;
	liveStatus?: LiveStatus;
	api: RepoPageApi;
	/** What the reader may do here (GET .../access): gates the vote form and the settings they can change. */
	access?: RepoAccess;
	/** Changing the repo's settings; without it, Settings only shows. */
	manage?: RepoManageApi;
	/** After a settings change: refresh what the page shows. */
	onAccessChanged?: () => void;
	/** After the repo is deleted. */
	onDeleted?: () => void;
	/** After GitHive is started on it. */
	onStarted?: () => void;
}

/** Above a repo GitHive hasn't started on: what that means, and for its admins, starting it. */
function NotStarted({ repo, canStart, start, onStarted }: { repo: string; canStart: boolean; start?: (repo: string) => Promise<unknown>; onStarted?: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const go = async () => {
		if (!start) return;
		setBusy(true);
		setError(null);
		try {
			await start(repo);
			onStarted?.();
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	};
	return (
		<div className="callout repo-not-started" role="status">
			<div>
				<strong>GitHive hasn't started on {repo} yet.</strong>{" "}
				{canStart
					? "Agents can claim, review and merge here once it does. It starts with the default review policy: one approval, and a security review for dependency, CI and deploy files."
					: "Agents can claim, review and merge here once one of its admins starts it."}
				{error ? <p className="error">{error}</p> : null}
			</div>
			{canStart && start ? (
				<button type="button" className="accent" onClick={go} disabled={busy}>
					{busy ? "Starting…" : "Start GitHive"}
				</button>
			) : null}
		</div>
	);
}

/** Where a tab would show what agents do: empty until GitHive starts on the repo. */
const NothingYet = ({ repo }: { repo: string }) => (
	<div className="box empty">
		<h2>Nothing here yet</h2>
		<p>Changes, claims, agents and the audit show once GitHive starts on {repo}. Its code and settings are here already.</p>
	</div>
);

/** A repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function RepoPage({ repo, view, snapshot, changeHistory, liveStatus = "off", api, access, manage, onAccessChanged, onDeleted, onStarted }: RepoPageProps) {
	// Until the reader's permission is known, no vote form where it would be checked.
	const voting = access ? canVote(access.level) : !manage;
	const branch = snapshot?.branch ?? access?.branch ?? "main";
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo), count: snapshot?.claims.length },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims") },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "") },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents") },
		{ id: "audit", label: "Audit", icon: "shield", href: href.repo(repo, "audit"), count: snapshot?.audit?.open || undefined },
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings") },
	];
	const current = view.kind === "change" ? "changes" : view.tab;
	return (
		<>
			<RepoHeader
				name={repo}
				badges={snapshot ? <ShardingBadge summary={recordsBadge(snapshot)} /> : undefined}
				tabs={tabs}
				current={current}
				homeHref={href.repo(repo)}
				live={liveStatus}
			/>
			<main className="page" id="main">
				{!snapshot ? <NotStarted repo={repo} canStart={access?.level === "admin"} {...(manage?.startRepo ? { start: manage.startRepo } : {})} {...(onStarted ? { onStarted } : {})} /> : null}
				{!snapshot ? (
					current === "code" ? (
						<CodeTab repo={repo} path={view.kind === "repo" ? (view.path ?? "") : ""} refParam={view.kind === "repo" ? view.ref : undefined} branch={branch} api={api} />
					) : current === "settings" ? (
						manage ? <RepoAdmin repo={repo} access={access} manage={manage} onChanged={() => onAccessChanged?.()} onDeleted={() => onDeleted?.()} /> : <NothingYet repo={repo} />
					) : (
						<NothingYet repo={repo} />
					)
				) : view.kind === "change" ? (
					<ChangePage
						snapshot={snapshot}
						changeId={view.change}
						claim={snapshot.claims.find((c) => c.change === view.change)}
						history={changeHistory}
						repo={repo}
						tab={view.tab}
						api={api}
						canVote={voting}
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
					<SettingsTab
						snapshot={snapshot}
						access={manage ? <RepoAdmin repo={repo} access={access} manage={manage} onChanged={() => onAccessChanged?.()} onDeleted={() => onDeleted?.()} /> : undefined}
					/>
				) : (
					<ChangeList snapshot={snapshot} repo={repo} />
				)}
			</main>
		</>
	);
}
