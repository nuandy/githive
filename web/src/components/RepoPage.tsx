import { type ReactNode, useState } from "react";
import type { VoteApi } from "./VoteForm";
import type {
	BranchHistory,
	DemoRunStatus,
	LandingStretch,
	ChangeHistory,
	GiveUpAnswer,
	HiveEvent,
	HiveStatus,
	RepoAccess,
	PullAnswer,
	RepoLanding,
	RepoSnapshot,
	SettingsInput,
} from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { canVote, canWrite } from "../lib/permissions";
import { BranchRules } from "./BranchRules";
import { GitHubLink } from "./GitHubLink";
import { GitHubSettings } from "./GitHubSettings";
import { MergeSettings } from "./MergeSettings";
import { RepoAdmin, type RepoManageApi } from "./RepoAdmin";
import { holdersFromSnapshot } from "../lib/claimsMap";
import { recordsBadge } from "../lib/claimStatus";
import type { LiveStatus } from "../lib/liveFeed";
import { href, type ChangeTab, type RepoTab } from "../lib/routes";
import { justFinished, stretchWords } from "../lib/stretch";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { AgentsTab } from "./Agents";
import { ClaimsTab } from "./ClaimsMap";
import { HistoryTab } from "./History";
import { HiveTab } from "./HiveTab";
import type { HostedAgentsApi } from "./HostedAgents";
import { CodeTab, type CodeApi } from "./CodeBrowser";
import { ChangePage } from "./ChangePage";
import { AuditTab, ChangeList, SettingsTab } from "./RepoTabs";
import { Overview } from "./Overview";
import { Page } from "./Page";
import { RepoHeader } from "./RepoHeader";
import { SiteLink } from "./SiteLink";
import { ShardingBadge } from "./StatusPill";
import type { TabItem } from "./Tabs";
import { Box, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";

/** The Agents tab's hosted agents: shown when the dashboard can read them, started and stopped by writers. */
function hostedAgentsApi(api: RepoPageApi, writes: boolean): HostedAgentsApi | undefined {
	if (!api.hostedAgents) return undefined;
	const hosted: HostedAgentsApi = { hostedAgents: api.hostedAgents };
	if (!writes) return hosted;
	if (api.startHostedAgents) hosted.startHostedAgents = api.startHostedAgents;
	if (api.stopHostedAgents) hosted.stopHostedAgents = api.stopHostedAgents;
	return hosted;
}

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
		/** The demo run that made a repo, for the Hive tab's banner (stand-ins may leave it out). */
		demoRun?: (repo: string) => Promise<DemoRunStatus>;
		/** GitHive's hosted agents on the repo, for the Agents tab (stand-ins may leave it out). */
		hostedAgents?: (repo: string) => Promise<HiveStatus | null>;
		/** People who can write: start or stop the repo's hosted agents. */
		startHostedAgents?: (repo: string, count: number, minutes: number) => Promise<unknown>;
		stopHostedAgents?: (repo: string) => Promise<unknown>;
		/** The changes landed on a branch, for the History tab (stand-ins may leave it out). */
		history?: (repo: string, branch: string) => Promise<BranchHistory>;
		/** People who can write: make a branch, merge a change. */
		makeBranch?: (repo: string, name: string, from: string) => Promise<{ name: string; made?: string }>;
		merge?: (
			repo: string,
			change: string,
		) => Promise<{ ok: boolean; commit?: string; reasons?: string[]; conflicts?: string[] }>;
		/** People who can write: open the standing pull request on GitHub, or find it. */
		githubPull?: (repo: string) => Promise<PullAnswer>;
		/** People who can write: give up GitHub's change, freeing its paths. */
		giveUpGitHub?: (repo: string, change: string) => Promise<GiveUpAnswer>;
		/** People who can write: bring GitHub's changes back again, after they were given up or sent back. */
		githubAgain?: (repo: string) => Promise<unknown>;
	};

export interface RepoPageProps {
	repo: string;
	view: RepoView;
	/** Its claims and votes; null when GitHive hasn't started on it yet (its code and settings still show). */
	snapshot: RepoSnapshot | null;
	/** On a change page: the change's history (undefined while loading, null if unreadable). */
	changeHistory?: ChangeHistory | null;
	/** Why the audit couldn't be read, and reading it again: the Audit tab says so in its place. */
	auditError?: string;
	onAuditRetry?: () => void;
	liveStatus?: LiveStatus;
	/** The repo's last stretch of work, from the repo list's summary: "all landed" by its name once it ends. */
	lastStretch?: LandingStretch;
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
		<Callout
			role="status"
			className={cn(
				"mb-4 flex-wrap justify-between",
				// Its error, a little under what it says.
				"[&_p]:mt-1.5",
			)}
		>
			<div className="min-w-0 flex-[1_1_24rem]">
				<strong>GitHive hasn't started on {repo} yet.</strong>{" "}
				{canStart
					? "Agents can claim, review and merge here once it does. It starts with the defaults: no " +
						"reviews and no checks, so a change merges once it's pushed. Its admins change them in " +
						"Settings."
					: "Agents can claim, review and merge here once one of its admins starts it."}
				{error ? <p className="animate-appear text-bad">{error}</p> : null}
			</div>
			{canStart && start ? (
				<Button variant="primary" className="flex-none" onClick={startRepo} disabled={busy}>
					{busy ? "Starting…" : "Start GitHive"}
				</Button>
			) : null}
		</Callout>
	);
}

/** Where a tab would show what agents do: empty until GitHive starts on the repo. */
const NothingYet = ({ repo }: { repo: string }) => (
	<Box asChild>
		<Empty>
			<h2>Nothing here yet</h2>
			<p>
				Changes, claims, agents and the audit show once GitHive starts on {repo}. Its code and settings are here
				already.
			</p>
		</Empty>
	</Box>
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
			<GitHubSettings branch={branch} github={snapshot.github} save={save} onSaved={onSaved} />
		</>
	);
}

interface RepoTabContentProps extends Pick<
	RepoPageProps,
	"repo" | "view" | "snapshot" | "changeHistory" | "auditError" | "onAuditRetry" | "api" | "access" | "manage"
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
	auditError,
	onAuditRetry,
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
				giveUp={canWrite(access?.level) ? api.giveUpGitHub : undefined}
				previewable={access?.visibility === "public"}
			/>
		);
	}
	switch (current) {
		case "audit":
			return <AuditTab snapshot={snapshot} error={auditError} onRetry={onAuditRetry} />;
		case "hive":
			return <HiveTab repo={repo} branch={branch} snapshot={snapshot} api={api} />;
		case "history":
			return <HistoryTab repo={repo} branch={branch} api={api} />;
		case "claims":
			return <ClaimsTab repo={repo} branch={branch} holders={holdersFromSnapshot(snapshot, repo)} api={api} />;
		case "agents":
			return <AgentsTab repo={repo} snapshot={snapshot} hosted={hostedAgentsApi(api, canWrite(access?.level))} />;
		case "settings": {
			const editor =
				access?.level === "admin" && manage?.changeSettings ? (
					<SettingsEditor repo={repo} branch={branch} snapshot={snapshot} manage={manage} onSaved={onSettingsChanged} />
				) : undefined;
			return <SettingsTab snapshot={snapshot} access={admin} editor={editor} />;
		}
	}
	return (
		<ChangesTab
			repo={repo}
			branch={branch}
			asked={view.branch || undefined}
			snapshot={snapshot}
			api={api}
			canWrite={canWrite(access?.level)}
			onBranchMade={onSettingsChanged}
		/>
	);
}

/**
 * The Changes tab: a branch's overview, then its open changes. Both read one landing, so a change being checked to
 * land says so in each.
 */
function ChangesTab({
	repo,
	branch,
	asked,
	snapshot,
	api,
	canWrite,
	onBranchMade,
}: {
	repo: string;
	branch: string;
	/** The branch the address asks for. */
	asked: string | undefined;
	snapshot: RepoSnapshot;
	api: RepoPageProps["api"];
	canWrite: boolean;
	onBranchMade?: () => void;
}) {
	// The branch asked for, when the repo has it; else the project's.
	const shown = asked && (snapshot.branches ?? []).some((known) => known.name === asked) ? asked : branch;
	const landing = usePoll(api.landing ? `landing:${repo}:${shown}` : null, () => api.landing!(repo, shown), 5_000);
	return (
		<>
			<Overview
				repo={repo}
				branch={branch}
				shown={asked}
				snapshot={snapshot}
				api={api}
				canWrite={canWrite}
				onBranchMade={onBranchMade}
				{...(landing.data ? { landing: landing.data } : {})}
			/>
			<ChangeList snapshot={snapshot} repo={repo} shown={shown} {...(landing.data ? { landing: landing.data } : {})} />
		</>
	);
}

/** By the repo's name once a stretch of work has landed and nothing's open: that it's done, and how much. */
function AllLandedBadge({ stretch }: { stretch: LandingStretch }) {
	return (
		<span
			className="rounded-full border border-good/40 px-2.5 py-0.5 text-ui font-semibold text-good"
			title={stretchWords(stretch)}
		>
			✓ All landed
		</span>
	);
}

/** A repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function RepoPage({
	repo,
	view,
	snapshot,
	changeHistory,
	auditError,
	onAuditRetry,
	liveStatus = "off",
	lastStretch,
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
		{ id: "hive", label: "Hive", icon: "activity", href: href.repo(repo) },
		{ id: "changes", label: "Changes", icon: "pull", href: href.repo(repo, "changes"), count: snapshot?.claims.length },
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
	// A tab's content fades in as you switch to it; the first one comes in with the page.
	const switched = useChanged(current);
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
				heading={view.kind !== "change"}
				badges={
					snapshot ? (
						<>
							<ShardingBadge summary={recordsBadge(snapshot)} />
							{!snapshot.claims.length && justFinished(lastStretch) ? <AllLandedBadge stretch={lastStretch} /> : null}
						</>
					) : undefined
				}
				aside={
					<>
						{access?.visibility === "public" ? <SiteLink repo={repo} /> : null}
						{snapshot?.github ? (
							<GitHubLink
								repo={repo}
								github={snapshot.github}
								openPull={canWrite(access?.level) ? api.githubPull : undefined}
								again={canWrite(access?.level) ? api.githubAgain : undefined}
								onChanged={onSettingsChanged}
							/>
						) : null}
					</>
				}
				tabs={tabs}
				current={current}
				homeHref={href.repo(repo)}
				live={liveStatus}
			/>
			<Page>
				{!snapshot ? (
					<NotStarted
						repo={repo}
						canStart={access?.level === "admin"}
						start={manage?.startRepo}
						onStarted={onStarted}
					/>
				) : null}
				<div key={current} className={switched ? "animate-fade" : undefined}>
					<RepoTabContent
						repo={repo}
						view={view}
						current={current}
						snapshot={snapshot}
						changeHistory={changeHistory}
						auditError={auditError}
						onAuditRetry={onAuditRetry}
						branch={branch}
						api={api}
						access={access}
						manage={manage}
						admin={admin}
						voting={voting}
						onSettingsChanged={onSettingsChanged}
					/>
				</div>
			</Page>
		</>
	);
}
