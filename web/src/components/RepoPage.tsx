import { type ReactNode, useState } from "react";
import type { VoteApi } from "./VoteForm";
import type {
	BranchHistory,
	DemoRunStatus,
	LandingStretch,
	ChangeDiff,
	ChangeHistory,
	HiveEvent,
	ReleaseAnswer,
	HiveStatus,
	RepoAccess,
	PullAnswer,
	RepoLanding,
	RepoSnapshot,
} from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { canVote, canWrite } from "../lib/permissions";
import { GitHubLink } from "./GitHubLink";
import { RepoAccessBox, type RepoManageApi } from "./RepoAdmin";
import { RepoSettings } from "./RepoSettings";
import { openOn, parseFilter } from "../lib/changeList";
import type { LiveStatus } from "../lib/liveFeed";
import { href, type ChangeTab, type RepoTab, type SettingsSection } from "../lib/routes";
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
import { COLUMN, Main } from "./Page";
import { type HeaderLink, RepoHeader } from "./RepoHeader";
import { SiteLink } from "./SiteLink";
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
			/** Settings tab: the section shown. */ section?: SettingsSection;
			/** Changes tab: the list's filter (see changeList.ts), when not all. */ filter?: string;
	  }
	| {
			kind: "change";
			change: string;
			tab: ChangeTab;
			/** Files tab: the file shown. */ file?: string;
			/** Scroll to the decision box and focus it once the change is read. */ decide?: boolean;
	  };

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
		/** A change's files, for its Files tab (stand-ins may leave it out). */
		diff?: (repo: string, change: string) => Promise<ChangeDiff>;
		/** People who can write: release a change's claim, whoever's it is, saying why. */
		release?: (repo: string, change: string, reason: string) => Promise<ReleaseAnswer>;
		/** People who can write: bring GitHub's changes back again, after they were given up or sent back. */
		githubAgain?: (repo: string) => Promise<unknown>;
	};

export interface RepoPageProps {
	repo: string;
	view: RepoView;
	/** Its claims and votes; null when GitHive hasn't started on it yet (its code and settings still show). */
	snapshot: RepoSnapshot | null;
	/** Its snapshot isn't read yet: the header and tabs show, from the address, over "Loading…". */
	loading?: boolean;
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
	/** After a person lands or releases a change from its page: read the repo and the change afresh. */
	onChangeActed?: () => void;
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

interface RepoTabContentProps extends Pick<
	RepoPageProps,
	"repo" | "view" | "snapshot" | "changeHistory" | "auditError" | "onAuditRetry" | "api" | "access"
> {
	/** The tab shown: a change's page shows under Changes. */
	current: RepoTab | "changes";
	branch: string;
	/** The Settings tab: an admin's sections, or what readers see. */
	settings: ReactNode;
	voting: boolean;
	onSettingsChanged?: () => void;
	onChangeActed?: (() => void) | undefined;
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
	settings,
	voting,
	onSettingsChanged,
	onChangeActed,
}: RepoTabContentProps) {
	if (current === "code") {
		return (
			<CodeTab
				repo={repo}
				path={view.kind === "repo" ? (view.path ?? "") : ""}
				refParam={view.kind === "repo" ? view.ref : undefined}
				branch={branch}
				api={api}
				snapshot={snapshot}
			/>
		);
	}
	if (current === "settings") return settings ?? <NothingYet repo={repo} />;
	if (!snapshot) return <NothingYet repo={repo} />;
	if (view.kind === "change") {
		return (
			<ChangeView
				repo={repo}
				view={view}
				snapshot={snapshot}
				changeHistory={changeHistory}
				api={api}
				access={access}
				voting={voting}
				onActed={onChangeActed}
			/>
		);
	}
	switch (current) {
		case "audit":
			return (
				<AuditWithHistory
					repo={repo}
					branch={branch}
					snapshot={snapshot}
					api={api}
					error={auditError}
					onRetry={onAuditRetry}
				/>
			);
		case "hive":
			return <HiveTab repo={repo} branch={branch} snapshot={snapshot} api={api} writes={canWrite(access?.level)} />;
		case "history":
			return <HistoryTab repo={repo} branch={branch} api={api} />;
		case "claims":
			return <ClaimsTab repo={repo} branch={branch} snapshot={snapshot} api={api} />;
		case "agents":
			return <AgentsTab repo={repo} snapshot={snapshot} hosted={hostedAgentsApi(api, canWrite(access?.level))} />;
	}
	return (
		<ChangesTab
			repo={repo}
			branch={branch}
			asked={view.branch || undefined}
			filter={view.kind === "repo" ? view.filter : undefined}
			snapshot={snapshot}
			api={api}
			canWrite={canWrite(access?.level)}
			onBranchMade={onSettingsChanged}
		/>
	);
}

/**
 * A change's page, with what it reads beside the change: the landing of the branch it lands on, polled as the Changes
 * tab polls it, so a change being checked says Landing; and its files, read again as its head moves.
 */
function ChangeView({
	repo,
	view,
	snapshot,
	changeHistory,
	api,
	access,
	voting,
	onActed,
}: {
	repo: string;
	view: Extract<RepoView, { kind: "change" }>;
	snapshot: RepoSnapshot;
	changeHistory: ChangeHistory | null | undefined;
	api: RepoPageProps["api"];
	access: RepoAccess | undefined;
	voting: boolean;
	/** After a person lands or releases it here. */
	onActed?: (() => void) | undefined;
}) {
	const claim = snapshot.claims.find((each) => each.change === view.change);
	const branch = claim?.into ?? changeHistory?.branch ?? snapshot.branch ?? "main";
	const landing = usePoll(
		api.landing && claim ? `landing:${repo}:${branch}` : null,
		() => api.landing!(repo, branch),
		5_000,
	);
	// Its files, up to about a megabyte of diff, are read only on the Files tab. Kept by the server like the change's own
	// view, they can come from an earlier push for a moment: asked again soon until they're the head's.
	const head = claim?.head ?? changeHistory?.released.find((release) => release.mergedAs)?.mergedAs ?? "";
	const pushed = `${repo}:${view.change}:${head}`;
	const diffKey = api.diff && view.tab === "files" ? `diff:${pushed}` : null;
	const [behind, setBehind] = useState(false);
	const diff = usePoll(diffKey, () => api.diff!(repo, view.change), behind ? 5_000 : 120_000);
	const nowBehind = !!claim?.head && diff.data?.of === "head" && !!diff.data.head && diff.data.head !== claim.head;
	if (nowBehind !== behind) setBehind(nowBehind);
	// How many files it changed, once read for this push: the Files tab keeps its count on the other tabs.
	const [counted, setCounted] = useState<{ pushed: string; total: number }>();
	if (diff.data && (counted?.pushed !== pushed || counted.total !== diff.data.total))
		setCounted({ pushed, total: diff.data.total });
	const writes = canWrite(access?.level);
	return (
		<ChangePage
			snapshot={snapshot}
			changeId={view.change}
			claim={claim}
			history={changeHistory}
			repo={repo}
			tab={view.tab}
			file={view.file}
			api={api}
			canVote={voting}
			access={access ? { by: access.by, teams: access.teams } : undefined}
			landing={landing.data}
			diff={diff.data ?? (diff.error ? null : undefined)}
			fileCount={counted?.pushed === pushed ? counted.total : undefined}
			diffError={diff.error}
			onDiffRetry={diff.refresh}
			merge={writes ? api.merge : undefined}
			release={writes ? api.release : undefined}
			decide={!!view.decide}
			onActed={() => {
				landing.refresh();
				onActed?.();
			}}
			previewable={access?.visibility === "public"}
		/>
	);
}

/**
 * The Changes tab: which branch it shows, then that branch's open changes, read with what's landing on it, so a
 * change being checked to land says so.
 */
function ChangesTab({
	repo,
	branch,
	asked,
	filter,
	snapshot,
	api,
	canWrite,
	onBranchMade,
}: {
	repo: string;
	branch: string;
	/** The branch the address asks for. */
	asked: string | undefined;
	/** The list's filter the address asks for. */
	filter: string | undefined;
	snapshot: RepoSnapshot;
	api: RepoPageProps["api"];
	canWrite: boolean;
	onBranchMade?: () => void;
}) {
	const shown = shownBranch(snapshot, { kind: "repo", tab: "changes", ...(asked ? { branch: asked } : {}) }, branch);
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
			/>
			<ChangeList
				snapshot={snapshot}
				repo={repo}
				shown={shown}
				filter={parseFilter(filter)}
				{...(landing.data ? { landing: landing.data } : {})}
			/>
		</>
	);
}

/** The Audit tab, with what's landed on the project's branch, so a review of a landed change names it. */
function AuditWithHistory({
	repo,
	branch,
	api,
	...props
}: Omit<Parameters<typeof AuditTab>[0], "landed"> & { branch: string; api: RepoPageApi }) {
	const history = usePoll(api.history ? `history:${repo}:${branch}` : null, () => api.history!(repo, branch), 60_000);
	return <AuditTab repo={repo} landed={history.data?.changes} {...props} />;
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

/** Why a tab has nothing to show before GitHive starts on the repo. */
export const NOT_STARTED_TAB = "Shows once GitHive starts on this repo";

/**
 * A repo's tabs, in order (the keys 1 to 8 choose them). Before GitHive starts on it, those that show what agents do
 * are dimmed; while its snapshot loads, they show without counts.
 */
export function repoTabs(
	repo: string,
	snapshot: RepoSnapshot | null | undefined,
	/** The Changes tab's count: the open changes on the branch it shows (all claims when not given). */
	openChanges?: number,
): TabItem[] {
	const notStarted = snapshot === null;
	const unavailable = notStarted ? { unavailable: NOT_STARTED_TAB } : {};
	return [
		{ id: "hive", label: "Hive", icon: "activity", href: href.repo(repo) },
		{
			id: "changes",
			label: "Changes",
			icon: "pull",
			href: href.repo(repo, "changes"),
			count: openChanges ?? snapshot?.claims.length,
			...unavailable,
		},
		{ id: "history", label: "History", icon: "commit", href: href.repo(repo, "history") },
		{ id: "claims", label: "Claims", icon: "folder", href: href.repo(repo, "claims"), ...unavailable },
		{ id: "code", label: "Code", icon: "file", href: href.code(repo, "") },
		{ id: "agents", label: "Agents", icon: "user", href: href.repo(repo, "agents"), ...unavailable },
		{
			id: "audit",
			label: "Audit",
			icon: "shield",
			href: href.repo(repo, "audit"),
			count: snapshot?.audit?.open || undefined,
			...unavailable,
		},
		{ id: "settings", label: "Settings", icon: "settings", href: href.repo(repo, "settings") },
	];
}

/** The header's links, for its ⋯ menu on a phone: the repo's site, its GitHub repo and its standing pull request. */
function headerLinks(repo: string, snapshot: RepoSnapshot | null, access: RepoAccess | undefined): HeaderLink[] {
	const links: HeaderLink[] = [];
	if (access?.visibility === "public")
		links.push({ label: "View site", href: href.site(repo), icon: "eye", external: true });
	const github = snapshot?.github;
	if (github) {
		links.push({
			label: `${github.repo} on GitHub`,
			href: `https://github.com/${github.repo}`,
			icon: "repo",
			external: true,
		});
		if (github.sync === "pr" && github.pull)
			links.push({ label: `Pull request #${github.pull.number}`, href: github.pull.url, icon: "pull", external: true });
	}
	return links;
}

// Under the repo's tabs, which stick under the top bar, what sticks in a tab starts below them.
const UNDER_TABS = "[--topbar-height:calc(var(--bar-height)+var(--repo-tabs-height))]";

/** The branch the Changes tab shows: the one the address asks for, when the repo has it; else the project's. */
function shownBranch(snapshot: RepoSnapshot, view: RepoView, branch: string): string {
	const asked = view.kind === "repo" && view.tab === "changes" ? view.branch : undefined;
	return asked && (snapshot.branches ?? []).some((known) => known.name === asked) ? asked : branch;
}

/** A repo: claims in force as its changes, its claims map, code, agents, audit and settings, or one change. */
export function RepoPage({
	repo,
	view,
	snapshot,
	loading = false,
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
	onChangeActed,
}: RepoPageProps) {
	// Until the reader's permission is known, no vote form where it would be checked.
	const voting = access ? canVote(access.level) : !manage;
	const branch = snapshot?.branch ?? access?.branch ?? "main";
	const tabs = repoTabs(
		repo,
		loading ? undefined : snapshot,
		snapshot ? openOn(snapshot, shownBranch(snapshot, view, branch)).length : undefined,
	);
	const current = view.kind === "change" ? "changes" : view.tab;
	// A tab's content fades in as you switch to it, or as it takes the place of "Loading…"; the first one comes in with
	// the page.
	const shown = `${current}${loading ? ":loading" : ""}`;
	const switched = useChanged(shown);
	// An admin's Settings has a page per section; everyone else reads how changes merge and who may do what.
	let settings: ReactNode = null;
	if (manage && access?.level === "admin")
		settings = (
			<RepoSettings
				repo={repo}
				branch={branch}
				section={view.kind === "repo" ? (view.section ?? "general") : "general"}
				snapshot={snapshot}
				access={access}
				manage={manage}
				{...(onSettingsChanged ? { onSaved: onSettingsChanged } : {})}
				onAccessChanged={() => onAccessChanged?.()}
				onDeleted={() => onDeleted?.()}
			/>
		);
	else if (snapshot)
		settings = (
			<SettingsTab snapshot={snapshot} access={manage ? <RepoAccessBox repo={repo} access={access} /> : null} />
		);
	else if (manage) settings = <RepoAccessBox repo={repo} access={access} />;
	const site = access?.visibility === "public";
	return (
		<Main className="flex flex-1 flex-col">
			<RepoHeader
				name={repo}
				heading={view.kind !== "change"}
				visibility={access?.visibility}
				badges={
					snapshot && !snapshot.claims.length && justFinished(lastStretch) ? (
						<AllLandedBadge stretch={lastStretch} />
					) : undefined
				}
				aside={
					site || snapshot?.github ? (
						<>
							{/* On a phone, the site and GitHub's links are in the ⋯ menu. */}
							{site ? (
								<span className="to-560:hidden">
									<SiteLink repo={repo} />
								</span>
							) : null}
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
					) : undefined
				}
				links={headerLinks(repo, snapshot, access)}
				tabs={tabs}
				current={current}
				homeHref={href.repo(repo)}
				// Before GitHive starts on it, there's nothing live to show.
				live={snapshot ? liveStatus : "off"}
			/>
			<div className={cn(COLUMN, UNDER_TABS)}>
				{!snapshot && !loading ? (
					<NotStarted
						repo={repo}
						canStart={access?.level === "admin"}
						start={manage?.startRepo}
						onStarted={onStarted}
					/>
				) : null}
				<div key={shown} className={switched ? "animate-fade" : undefined}>
					{loading ? (
						<p className="my-3.75 py-8 text-center text-muted-foreground" role="status">
							Loading {repo}…
						</p>
					) : (
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
							settings={settings}
							voting={voting}
							onSettingsChanged={onSettingsChanged}
							onChangeActed={onChangeActed}
						/>
					)}
				</div>
			</div>
		</Main>
	);
}
