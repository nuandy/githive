import { type ReactNode, useState } from "react";
import "./RepoPage.css";
import type { VoteApi } from "./VoteForm";
import type {
	BranchHistory,
	ChangeHistory,
	HiveEvent,
	RepoAccess,
	RepoLanding,
	RepoSnapshot,
	SettingsInput,
} from "../api";
import { canVote, canWrite } from "../lib/permissions";
import { BranchRules } from "./BranchRules";
import { MergeSettings } from "./MergeSettings";
import { RepoAdmin, type RepoManageApi } from "./RepoAdmin";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { recordsBadge } from "../lib/claimStatus";
import type { LiveStatus } from "../lib/liveFeed";
import { href, type ChangeTab, type RepoTab } from "../lib/routes";
import { messageOf } from "../lib/errors";
import { AgentsTab } from "./Agents";
import { ClaimsTab } from "./ClaimsMap";
import { HistoryTab } from "./History";
import { HiveTab } from "./HiveTab";
import { CodeTab, type CodeApi } from "./CodeBrowser";
import { ChangePage } from "./ChangePage";
import { AuditTab, ChangeList, SettingsTab } from "./RepoTabs";
import { Overview } from "./Overview";
import { RepoHeader } from "./RepoHeader";
import { ShardingBadge } from "./StatusPill";
import type { TabItem } from "./Tabs";

export type RepoView =
	| {
			kind: "repo";
			tab: RepoTab;
			/** Code tab */ path?: string;
			ref?: string;
			/** Changes tab: the branch shown, when not the project's. */ branch?: string;
	  }
	| { kind: "change"; change: string; tab: ChangeTab };

/** Everything a repo's pages call. The dashboard's api object satisfies it; tests pass stand-ins. */
export type RepoPageApi = CodeApi &
	VoteApi & {
		/** What's landing on a branch, for the overview (stand-ins may leave it out). */
		landing?: (repo: string, branch: string) => Promise<RepoLanding>;
		/** The hive's recent events, for the Hive tab's live feed (stand-ins may leave it out). */
		events?: (repo: string) => Promise<{ events: HiveEvent[] }>;
		/** The changes landed on a branch, for the History tab (stand-ins may leave it out). */
		history?: (repo: string, branch: string) => Promise<BranchHistory>;
		/** People who can write: make a branch, merge a change. */
		makeBranch?: (repo: string, name: string, from: string) => Promise<{ name: string; made?: string }>;
		merge?: (
			repo: string,
			change: string,
		) => Promise<{ ok: boolean; commit?: string; reasons?: string[]; conflicts?: string[] }>;
	};

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
	/** After its admins change how changes merge. */
	onSettingsChanged?: () => void;
}

/** Above a repo GitHive hasn't started on: what that means, and for its admins, starting it. */
function NotStarted({
	repo,
	canStart,
	start,
	onStarted,
}: {
	repo: string;
	canStart: boolean;
	start?: (repo: string) => Promise<unknown>;
	onStarted?: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const startRepo = async () => {
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
					? "Agents can claim, review and merge here once it does. It starts with the defaults: no " +
						"reviews and no checks, so a change merges once it's pushed. Its admins change them in " +
						"Settings."
					: "Agents can claim, review and merge here once one of its admins starts it."}
				{error ? <p className="error">{error}</p> : null}
			</div>
			{canStart && start ? (
				<button type="button" className="accent" onClick={startRepo} disabled={busy}>
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
		<p>
			Changes, claims, agents and the audit show once GitHive starts on {repo}. Its code and settings are here already.
		</p>
	</div>
);

/** For the repo's admins: the forms that change how changes merge. */
function SettingsEditor({
	repo,
	branch,
	snapshot,
	manage,
	onSaved,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	manage: RepoManageApi;
	onSaved?: () => void;
}) {
	const save = (settings: SettingsInput) => manage.changeSettings!(repo, settings);
	return (
		<>
			<MergeSettings snapshot={snapshot} save={save} onSaved={onSaved} />
			<BranchRules branch={branch} rules={snapshot.branchRules} save={save} onSaved={onSaved} />
		</>
	);
}

interface RepoTabContentProps extends Pick<
	RepoPageProps,
	"repo" | "view" | "snapshot" | "changeHistory" | "api" | "access" | "manage"
> {
	/** The tab shown: a change's page shows under Changes. */
	current: RepoTab | "changes";
	branch: string;
	/** The repo's access settings, for those who can change them. */
	admin: ReactNode;
	voting: boolean;
	onSettingsChanged?: () => void;
}

/** The current tab's content: before GitHive starts, only Code and Settings have any. */
function RepoTabContent({
	repo,
	view,
	current,
	snapshot,
	changeHistory,
	branch,
	api,
	access,
	manage,
	admin,
	voting,
	onSettingsChanged,
}: RepoTabContentProps) {
	if (current === "code") {
		return (
			<CodeTab
				repo={repo}
				path={view.kind === "repo" ? (view.path ?? "") : ""}
				refParam={view.kind === "repo" ? view.ref : undefined}
				branch={branch}
				api={api}
			/>
		);
	}
	if (!snapshot) return current === "settings" && admin ? admin : <NothingYet repo={repo} />;
	if (view.kind === "change") {
		return (
			<ChangePage
				snapshot={snapshot}
				changeId={view.change}
				claim={snapshot.claims.find((claim) => claim.change === view.change)}
				history={changeHistory}
				repo={repo}
				tab={view.tab}
				api={api}
				canVote={voting}
				merge={canWrite(access?.level) ? api.merge : undefined}
			/>
		);
	}
	switch (current) {
		case "audit":
			return <AuditTab snapshot={snapshot} />;
		case "hive":
			return <HiveTab repo={repo} branch={branch} snapshot={snapshot} api={api} />;
		case "history":
			return <HistoryTab repo={repo} branch={branch} api={api} />;
		case "claims":
			return <ClaimsTab repo={repo} branch={branch} holders={holdersFromSnapshot(snapshot, repo)} api={api} />;
		case "agents":
			return <AgentsTab snapshot={snapshot} />;
		case "settings": {
			const editor =
				access?.level === "admin" && manage?.changeSettings ? (
					<SettingsEditor repo={repo} branch={branch} snapshot={snapshot} manage={manage} onSaved={onSettingsChanged} />
				) : undefined;
			return <SettingsTab snapshot={snapshot} access={admin} editor={editor} />;
		}
	}
	// The branch asked for in the address, when the repo has it.
	const asked = view.branch && (snapshot.branches ?? []).some((known) => known.name === view.branch);
	return (
		<>
			<Overview
				repo={repo}
				branch={branch}
				shown={view.branch || undefined}
				snapshot={snapshot}
				api={api}
				canWrite={canWrite(access?.level)}
				onBranchMade={onSettingsChanged}
			/>
			<ChangeList snapshot={snapshot} repo={repo} shown={asked ? view.branch : branch} />
		</>
	);
}

/** A repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function RepoPage({
	repo,
	view,
	snapshot,
	changeHistory,
	liveStatus = "off",
	api,
	access,
	manage,
	onAccessChanged,
	onDeleted,
	onStarted,
	onSettingsChanged,
}: RepoPageProps) {
	// Until the reader's permission is known, no vote form where it would be checked.
	const voting = access ? canVote(access.level) : !manage;
	const branch = snapshot?.branch ?? access?.branch ?? "main";
	const tabs: TabItem[] = [
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo), count: snapshot?.claims.length },
		{ id: "hive", label: "Hive", icon: "activity", href: href.repo(repo, "hive") },
		{ id: "history", label: "History", icon: "commit", href: href.repo(repo, "history") },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims") },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "") },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents") },
		{
			id: "audit",
			label: "Audit",
			icon: "shield",
			href: href.repo(repo, "audit"),
			count: snapshot?.audit?.open || undefined,
		},
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings") },
	];
	const current = view.kind === "change" ? "changes" : view.tab;
	const admin = manage ? (
		<RepoAdmin
			repo={repo}
			access={access}
			manage={manage}
			onChanged={() => onAccessChanged?.()}
			onDeleted={() => onDeleted?.()}
		/>
	) : undefined;
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
				{!snapshot ? (
					<NotStarted
						repo={repo}
						canStart={access?.level === "admin"}
						start={manage?.startRepo}
						onStarted={onStarted}
					/>
				) : null}
				<RepoTabContent
					repo={repo}
					view={view}
					current={current}
					snapshot={snapshot}
					changeHistory={changeHistory}
					branch={branch}
					api={api}
					access={access}
					manage={manage}
					admin={admin}
					voting={voting}
					onSettingsChanged={onSettingsChanged}
				/>
			</main>
		</>
	);
}
