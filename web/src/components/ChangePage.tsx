import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ChangeDiff, ChangeHistory, ReleaseAnswer, RepoLanding, RepoSnapshot } from "../api";
import { useChanged } from "../hooks/useChanged";
import { identityName } from "../lib/agent";
import type { ChangeStatus } from "../lib/changeStatus";
import { claimStatus, isFromGitHub, votesForClaim, type Claim } from "../lib/claimStatus";
import { buildTimeline, changeEnding, historyStatus } from "../lib/changeTimeline";
import {
	branchSettings,
	conflictOf,
	landable,
	landsWith,
	latestCheck,
	meetsCount,
	primaryAction,
	type Reader,
	readerVote,
	roleLines,
} from "../lib/decision";
import { shortSha } from "../lib/model";
import { reducedMotion } from "../lib/motion";
import { timeAgo } from "../lib/relativeTime";
import { type ChangeTab, href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Awareness } from "./Awareness";
import { type MergeAnswer, type Outcome, OutcomeLine, ReleaseDialog } from "./ChangeActions";
import { ChangeFiles } from "./ChangeFiles";
import { ChangeSidebar, type ChangeRecord } from "./ChangeSidebar";
import { ChangeCommits } from "./Commits";
import { ConflictPanel } from "./ConflictPanel";
import { type ChangeEnding, DecisionBox, type PageTarget } from "./DecisionBox";
import { Icon } from "./Icon";
import { SiteLink } from "./SiteLink";
import { Tabs } from "./Tabs";
import { Timeline, TimelineEntry, TimelineList } from "./Timeline";
import { VoteForm, type VoteApi } from "./VoteForm";
import { Badge } from "./ui/badge";
import { Box, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";

export interface ChangePageProps {
	snapshot: RepoSnapshot;
	/** The change's id, from the address. */
	changeId: string;
	/** Its claim, while in force (the snapshot's, with approvals and hosted agents). */
	claim?: Claim;
	/** Its history in Git: undefined while loading, null if it couldn't be read. */
	history?: ChangeHistory | null;
	repo: string;
	tab: ChangeTab;
	/** Files tab: the file the address asks for. */
	file?: string | undefined;
	/** Whether the repo's site can be previewed as this change has it: only a public repo's is served. */
	previewable?: boolean;
	/** For a person's vote; without it, the page only shows. */
	api?: VoteApi;
	/** Whether the reader may vote (review or more in the repo); without it, no vote form. */
	canVote?: boolean;
	/** Who is reading (GET .../access): their identity and teams decide the roles they may vote as. */
	access?: Reader | undefined;
	/** What's landing on the change's branch: a change whose head is being checked says Landing. */
	landing?: RepoLanding | undefined;
	/** Its files: undefined while loading, null if they couldn't be read. */
	diff?: ChangeDiff | null | undefined;
	diffError?: string | undefined;
	onDiffRetry?: () => void;
	/**
	 * A person landing the change (write or more in the repo). It lands as its agent in a batch with the branch's other
	 * ready changes, stamped with their name.
	 */
	merge?: (repo: string, change: string) => Promise<MergeAnswer>;
	/** A person releasing the change's claim, with a reason (write or more in the repo). */
	release?: (repo: string, change: string, reason: string) => Promise<ReleaseAnswer>;
	/** Scroll to the decision box and focus it, once the change is read (the address asks the reader to decide). */
	decide?: boolean;
	/** The time leases are told against (tests fix it). */
	now?: number;
}

/** Whether a claim is GitHub's change, brought back by githive-github. */
export const isGitHubClaim = (claim: Pick<Claim, "agent" | "source">) => isFromGitHub(claim);

function statusOf(
	claim: Claim | undefined,
	history: ChangeHistory | null | undefined,
	context: Parameters<typeof claimStatus>[2],
	votes: Parameters<typeof claimStatus>[1],
): ChangeStatus | null {
	if (claim) return claimStatus(claim, votes, context);
	if (history) return historyStatus(history);
	return null;
}

/** The header's line about the change: who landed or released it, or who wants to land it. */
function ChangeHeadline({
	agent,
	ending,
	record,
	branchCode,
	into,
}: {
	agent: string;
	ending: ChangeEnding | null;
	record: ChangeRecord | undefined;
	branchCode: ReactNode;
	into: ReactNode;
}) {
	if (ending?.kind === "merged") {
		return (
			<>
				<strong>{agent}</strong> landed {branchCode} on {into} {timeAgo(ending.release.at)}
			</>
		);
	}
	if (ending) {
		return (
			<>
				<strong>{agent}</strong>’s change {branchCode} was released {timeAgo(ending.release.at)}
			</>
		);
	}
	return (
		<>
			<strong>{agent}</strong> wants to land {branchCode} on {into}
			{record?.since ? <span className="text-muted-foreground"> · opened {timeAgo(record.since)}</span> : null}
		</>
	);
}

/** Beside the conversation's column, indented past its avatars; flush with it on a narrow window. */
const INDENT = "ml-11 to-720:ml-0";

/**
 * A question the change's agent put to people, answered by voting. It asks the reader only when they can answer it
 * here: they may vote, and there's a pushed commit to vote on. Where a vote can't answer it (nothing is pushed, or
 * GitHive's builder needs what its claim doesn't hold), a person who can write is offered the claim's release.
 */
function AttentionCallout({
	attention,
	answerable,
	pushed,
	repo,
	change,
	release,
}: {
	attention: NonNullable<Claim["attention"]>;
	answerable: boolean;
	pushed: boolean;
	repo: string;
	change: string;
	release?: ((reason: string) => Promise<ReleaseAnswer>) | undefined;
}) {
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const outsideVote = !pushed || attention.agent === "githive-builder";
	return (
		<Callout tone="needs" role="status" className={INDENT}>
			<Icon name="alert" className="text-needs" />
			<div className="grid min-w-0 gap-1">
				<strong>
					{attention.agent} asks {answerable ? "you" : "a person"}
				</strong>
				<p className="max-w-measure">{attention.reason}</p>
				<p className="text-muted-foreground">
					{answerable
						? "Decide with your vote: it counts like a reviewer's and answers the question."
						: pushed
							? `A person who can review in ${repo} answers it by voting.`
							: "Nothing is pushed yet, so there's no commit to vote on."}
				</p>
				{release && outsideVote ? (
					<div className="mt-1 grid justify-items-start gap-1.5">
						<p className="max-w-measure">
							A vote can't give it what it asks for. Releasing its claim frees its paths, so another agent can take the
							work on with what it needs.
						</p>
						<ReleaseDialog change={change} release={release} onOutcome={setOutcome}>
							<Button size="sm">
								<Icon name="ban" size={14} />
								Release claim…
							</Button>
						</ReleaseDialog>
						<OutcomeLine outcome={outcome} />
					</div>
				) : null}
			</div>
		</Callout>
	);
}

/** Before the history is in: the latest push only. */
function LatestPush({ head }: { head: string | null | undefined }) {
	return (
		<TimelineList>
			<TimelineEntry icon="commit">
				<p className="m-0 wrap-anywhere">
					{head ? (
						<>
							latest push <code className="text-caption">{shortSha(head)}</code>
						</>
					) : (
						"nothing pushed yet"
					)}
				</p>
			</TimelineEntry>
		</TimelineList>
	);
}

/** While a change loads, or when the repo has no change by that name. */
function ChangeMissing({
	changeId,
	repo,
	loading,
	fades,
}: {
	changeId: string;
	repo: string;
	loading: boolean;
	/** Whether it comes once the change was looked for, rather than with the page. */
	fades: boolean;
}) {
	if (loading)
		return (
			<p className="my-[1em] text-muted-foreground" role="status">
				Loading {changeId}…
			</p>
		);
	return (
		<Box asChild>
			<Empty className={cn(fades && "animate-fade")}>
				<Icon name="alert" size={28} />
				<h2>Change not found</h2>
				<p>
					{repo} has no change named <code>{changeId}</code>. <a href={href.repo(repo, "changes")}>See open changes</a>.
				</p>
			</Empty>
		</Box>
	);
}

/** The agent's opening of the change: when, which paths it claims, and its intent. */
function OpeningComment({ agent, record }: { agent: string; record: ChangeRecord | undefined }) {
	return (
		<article className={cn("relative min-w-0 rounded-md border border-border bg-card", INDENT)}>
			{/* Its author's avatar, out in the margin the column is indented by. */}
			<span
				className="absolute top-3 -left-11 inline-flex size-8 items-center justify-center rounded-full bg-link-soft text-warn to-720:hidden"
				aria-hidden="true"
			>
				<Icon name="user" />
			</span>
			<div className="rounded-t-md border-b border-border bg-link-soft px-3.5 py-2.25 wrap-anywhere">
				<strong>{agent}</strong>{" "}
				<span className="text-muted-foreground">
					opened this change{record?.since ? ` ${timeAgo(record.since)}` : ""}
					{record?.paths.length ? ` · claims ${record.paths.join(", ")}` : ""}
				</span>
			</div>
			<div className="max-w-measure p-3.5 whitespace-pre-wrap wrap-anywhere">
				{record?.intent || <span className="text-muted-foreground">No description provided.</span>}
			</div>
		</article>
	);
}

/** A branch named in the header, in the link's blue. */
const BRANCH = "bg-link-soft text-caption text-link";

/** Where the decision box's links go: the vote form, the conflict panel and the awareness panel, by their ids. */
const TARGET_IDS: Record<PageTarget, string> = {
	vote: "vote",
	conflict: "conflict-panel",
	awareness: "awareness-panel",
};

/** Brings a part of the page into view and focuses it, so the keyboard's place goes there too. */
function bringIntoView(id: string) {
	const found = document.getElementById(id);
	found?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
	found?.focus({ preventScroll: true });
}

/**
 * A change, shown like a pull request: in force, landed or released. One decision box says where it stands and what
 * deciding on it needs, sticky beside every tab on a wide window and under the header on a narrow one; the tabs are
 * its conversation, its commits and its files.
 */
export function ChangePage({
	snapshot,
	changeId,
	claim,
	history,
	repo,
	tab,
	file,
	api,
	canVote = true,
	access,
	landing,
	diff,
	diffError,
	onDiffRetry,
	merge,
	release,
	decide = false,
	now,
	previewable = false,
}: ChangePageProps) {
	const branch = claim?.into || history?.branch || snapshot.branch || "main";
	const record = claim ?? history?.claim ?? undefined;
	const ending = history ? changeEnding(history) : null;
	const agent = record?.agent || ending?.release.agent || identityName(record?.by) || "agent";
	const title = (record?.intent ?? "").split("\n")[0]?.trim() || changeId;
	const votes = claim ? votesForClaim(claim, history?.votes ?? snapshot.votes) : (history?.votes ?? []);
	const reader = access ?? {};
	const { policy, verify } = branchSettings(snapshot, branch);
	const status = statusOf(claim, history, { policy, landing }, votes);
	// A change landing a whole branch shows that branch; any other, its own.
	const branchCode = <code className={BRANCH}>{claim?.source ?? `changes/${changeId}`}</code>;
	const into = <code className={BRANCH}>{branch}</code>;
	const timeline = history ? buildTimeline(history, repo).filter((item) => item.kind !== "opened") : [];
	// Whether the reader can answer an agent's question here: the vote form shows, on a pushed commit.
	const answerable = !!(claim?.head && api && canVote);
	const mine = claim ? readerVote(claim, votes, reader.by) : undefined;
	const canLand = !!(claim && merge && landable(claim, votes, { merge: history?.merge, landing, policy }));
	const action = primaryAction({ landable: canLand, voter: answerable, voted: !!mine });
	const releaseIt = claim && release ? (reason: string) => release(repo, changeId, reason) : undefined;
	const fileHref = (path: string) => href.change(repo, changeId, "files", path);
	// What comes once it's read fades in: the change in place of "Loading…", its history in place of the latest push,
	// and the other tab's content; what's there from the start comes with the page's own fade.
	const missing = !record && !ending;
	const pageFades = useChanged(missing);
	const historyFades = useChanged(history === undefined);
	const tabFades = useChanged(tab);

	// The decision box's links go to a part of the conversation: from another tab, by way of the conversation's.
	const [wanted, setWanted] = useState<PageTarget | null>(null);
	const goTo = (target: PageTarget) => {
		if (tab === "conversation") return bringIntoView(TARGET_IDS[target]);
		setWanted(target);
		window.location.hash = href.change(repo, changeId);
	};
	useEffect(() => {
		if (!wanted || tab !== "conversation") return;
		// Once the conversation is drawn.
		const frame = requestAnimationFrame(() => {
			bringIntoView(TARGET_IDS[wanted]);
			setWanted(null);
		});
		return () => cancelAnimationFrame(frame);
	}, [wanted, tab]);
	// Asked to decide: once the change is read, the box comes into view with the keyboard's place on it, once.
	const decided = useRef(false);
	useEffect(() => {
		if (!decide) decided.current = false;
		if (!decide || decided.current || missing) return;
		decided.current = true;
		bringIntoView("decide");
	}, [decide, missing]);

	if (missing)
		return <ChangeMissing changeId={changeId} repo={repo} loading={history === undefined} fades={historyFades} />;
	const loaded = historyFades && "animate-fade";

	// What its agent hears about it while its claim is in force: a conflict with its branch, and other changes' code.
	const heard =
		claim && history ? (
			<>
				{history.merge ? (
					<ConflictPanel
						id="conflict-panel"
						merge={history.merge}
						head={claim.head}
						repo={repo}
						fileHref={fileHref}
						className={cn(INDENT, loaded)}
					/>
				) : null}
				{history.awareness ? (
					<Awareness
						id="awareness-panel"
						awareness={history.awareness}
						claims={snapshot.claims}
						head={claim.head}
						repo={repo}
						fileHref={fileHref}
						className={cn(INDENT, loaded)}
					/>
				) : null}
			</>
		) : null;

	const details = (className: string) => (
		<ChangeSidebar claim={claim} record={record} agent={agent} reader={reader} now={now} className={className} />
	);
	const conversation = (
		<div className="grid min-w-0 gap-3.5">
			{claim?.attention ? (
				<AttentionCallout
					attention={claim.attention}
					answerable={answerable}
					pushed={!!claim.head}
					repo={repo}
					change={changeId}
					release={releaseIt}
				/>
			) : null}
			<OpeningComment agent={agent} record={record} />
			{history === undefined ? (
				<p className="m-0 ml-11 text-ui text-muted-foreground to-720:ml-0">Loading history…</p>
			) : null}
			{history ? <Timeline items={timeline} className={cn(loaded)} /> : <LatestPush head={claim?.head} />}
			{heard}
			{claim && api && canVote ? (
				<VoteForm repo={repo} claim={claim} policy={policy} api={api} reader={reader} mine={mine} className={INDENT} />
			) : null}
			{/* On a narrow window the details come last, under the conversation. */}
			{details("hidden border-t border-border pt-4 to-900:grid")}
		</div>
	);
	let content: ReactNode;
	if (tab === "commits")
		content =
			history === null ? (
				<p className="my-[1em] text-muted-foreground">This change's commits couldn't be read.</p>
			) : (
				<ChangeCommits history={history} repo={repo} />
			);
	else if (tab === "files")
		content = (
			<ChangeFiles
				repo={repo}
				changeId={changeId}
				diff={diff}
				error={diffError}
				onRetry={onDiffRetry}
				head={claim?.head}
				into={branch}
				file={file}
			/>
		);
	else content = conversation;

	return (
		<div className={cn(pageFades && "animate-fade")}>
			<div className="pb-3.5">
				<h1 className="text-display leading-[1.25] font-medium tracking-[-0.01em] wrap-anywhere to-720:text-title">
					{title}{" "}
					<span className="font-mono text-lead font-light text-muted-foreground to-720:text-body-sm">{changeId}</span>
				</h1>
				<div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-muted-foreground wrap-anywhere [&_strong]:text-foreground">
					<span>
						<ChangeHeadline agent={agent} ending={ending} record={record} branchCode={branchCode} into={into} />
					</span>
					{claim?.waitsOn?.length ? <Badge tone="warn">waits on {claim.waitsOn.join(", ")}</Badge> : null}
					{previewable && claim?.head ? <SiteLink repo={repo} change={changeId} /> : null}
				</div>
			</div>
			{/* Wide: the tabs and their content on the left, the decision box sticky on the right with the details under
			    it. Narrow: the box under the header, then the tabs. */}
			<div className="grid grid-cols-[minmax(0,1fr)_260px] grid-rows-[auto_1fr] gap-x-8 to-900:grid-cols-[minmax(0,1fr)] to-900:grid-rows-none">
				<div className="col-start-2 row-span-2 row-start-1 min-w-0 to-900:col-start-1 to-900:row-span-1 to-900:mb-4">
					<DecisionBox
						className="sticky top-[calc(var(--topbar-height)+12px)] to-900:static"
						repo={repo}
						changeId={changeId}
						status={status}
						summary={
							claim?.attention
								? `Waiting on ${answerable ? "you" : "a person"}: ${claim.attention.agent}'s question is in the conversation.`
								: undefined
						}
						inForce={!!claim}
						ending={ending}
						branch={branch}
						roles={claim ? roleLines(claim, votes, policy) : []}
						trusted={claim?.trusted}
						reader={reader}
						check={claim ? latestCheck(claim, votes, landing) : { kind: "none" }}
						checks={verify}
						conflict={claim?.head ? conflictOf({ ...claim, into: branch }, history?.merge) : null}
						meets={claim && history?.awareness ? meetsCount(history.awareness, snapshot.claims) : null}
						action={action}
						batch={claim ? landsWith(claim, snapshot, landing).map((each) => each.change) : []}
						land={merge && claim ? () => merge(repo, changeId) : undefined}
						release={releaseIt}
						github={!!claim && isGitHubClaim(claim)}
						onGo={goTo}
					/>
					{details("mt-5 to-900:hidden")}
				</div>
				<Tabs
					className="col-start-1 row-start-1 to-900:row-start-2"
					label="Change sections"
					current={tab}
					items={[
						{ id: "conversation", label: "Conversation", icon: "comment", href: href.change(repo, changeId) },
						{
							id: "commits",
							label: "Commits",
							icon: "commit",
							href: href.change(repo, changeId, "commits"),
							count: history?.commits.length,
						},
						{
							id: "files",
							label: "Files",
							icon: "file",
							href: href.change(repo, changeId, "files"),
							count: diff?.total,
						},
					]}
				/>
				<div
					key={tab}
					className={cn("col-start-1 row-start-2 min-w-0 pt-5 to-900:row-start-3", tabFades && "animate-fade")}
				>
					{content}
				</div>
			</div>
		</div>
	);
}
