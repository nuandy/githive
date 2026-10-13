import { SiteLink } from "./SiteLink";
import { type ReactNode, useState } from "react";
import { messageOf } from "../lib/errors";
import { VoteForm, type VoteApi } from "./VoteForm";
import type { ChangeHistory, GiveUpAnswer, RepoSnapshot } from "../api";
import { useChanged } from "../hooks/useChanged";
import { identityName } from "../lib/agent";
import type { ChangeStatus, Tone } from "../lib/changeStatus";
import { claimApprovalLabel, claimStatus, votesForClaim, type Claim } from "../lib/claimStatus";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { buildTimeline, changeEnding, historyStatus } from "../lib/changeTimeline";
import { cn } from "../lib/utils";
import { Awareness } from "./Awareness";
import { ChangeCommits } from "./Commits";
import { ConflictPanel } from "./ConflictPanel";
import { Icon, type IconName } from "./Icon";
import { Tabs } from "./Tabs";
import { Timeline, TimelineEntry, TimelineList } from "./Timeline";
import { ChangeSidebar, type ChangeRecord } from "./ChangeSidebar";
import { StatusPill } from "./StatusPill";
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
	tab: "conversation" | "commits";
	/** Whether the repo's site can be previewed as this change has it: only a public repo's is served. */
	previewable?: boolean;
	/** For a person's vote; without it, the page only shows. */
	api?: VoteApi;
	/** Whether the reader may vote (review or more in the repo); without it, no vote form. */
	canVote?: boolean;
	/**
	 * A person merging the change (write or more in the repo). It lands as its agent in a batch with the branch's
	 * other ready changes, stamped with their name.
	 */
	merge?: (
		repo: string,
		change: string,
	) => Promise<{ ok: boolean; commit?: string; reasons?: string[]; conflicts?: string[] }>;
	/**
	 * A person giving up GitHub's change (write or more in the repo): its claim released, so its paths are free, until
	 * GitHub's branch moves or someone asks again. Only GitHub's changes offer it.
	 */
	giveUp?: (repo: string, change: string) => Promise<GiveUpAnswer>;
	/** The time leases are told against (tests fix it). */
	now?: number;
}

/** Whether a claim is GitHub's change, brought back by githive-github. */
export const isGitHubClaim = (claim: Pick<Claim, "agent" | "source">) =>
	claim.agent === "githive-github" && !!claim.source?.startsWith("github/");

/** Give up GitHub's change, for a person who can write: the one claim someone other than its agent may release. */
function GiveUpButton({
	repo,
	change,
	giveUp,
}: {
	repo: string;
	change: string;
	giveUp: NonNullable<ChangePageProps["giveUp"]>;
}) {
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
	const giveUpChange = async () => {
		setBusy(true);
		setOutcome(null);
		try {
			const answer = await giveUp(repo, change);
			setOutcome(
				answer.ok
					? { ok: true, text: answer.note ?? "Given up: its paths are free." }
					: { ok: false, text: answer.refused ?? "It couldn't be given up." },
			);
		} catch (err) {
			setOutcome({ ok: false, text: messageOf(err) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<HeaderAction outcome={outcome}>
			<Button
				onClick={giveUpChange}
				disabled={busy}
				title="Releases its claim, so its paths are free; GitHive brings GitHub's changes back when GitHub's branch moves"
			>
				{busy ? "Giving up…" : "Give up GitHub's changes"}
			</Button>
		</HeaderAction>
	);
}

/** A person's action beside the change's status, and what came of it, which fades in. */
function HeaderAction({ outcome, children }: { outcome: { ok: boolean; text: string } | null; children: ReactNode }) {
	return (
		<div className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
			{children}
			{outcome ? (
				<p
					key={outcome.text}
					className={cn("m-0 animate-appear text-ui-lg", outcome.ok ? "text-good" : "text-bad")}
					role="status"
				>
					{outcome.text}
				</p>
			) : null}
		</div>
	);
}

type ChangeEnding = NonNullable<ReturnType<typeof changeEnding>>;

function statusOf(claim: Claim | undefined, history: ChangeHistory | null | undefined): ChangeStatus | null {
	if (claim) return claimStatus(claim);
	if (history) return historyStatus(history);
	return null;
}

/** Merge for a person, once a change is approved and waits on nothing. It's the same merge an agent asks for. */
function MergeButton({
	repo,
	change,
	merge,
}: {
	repo: string;
	change: string;
	merge: NonNullable<ChangePageProps["merge"]>;
}) {
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
	const mergeChange = async () => {
		setBusy(true);
		setOutcome(null);
		try {
			const merged = await merge(repo, change);
			setOutcome(
				merged.ok
					? { ok: true, text: `Merged as ${merged.commit?.slice(0, 8)}.` }
					: { ok: false, text: (merged.reasons ?? ["It couldn't merge."]).join(" ") },
			);
		} catch (err) {
			setOutcome({ ok: false, text: messageOf(err) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<HeaderAction outcome={outcome}>
			<Button variant="go" onClick={mergeChange} disabled={busy}>
				{busy ? "Merging… (its checks run first)" : "Merge"}
			</Button>
		</HeaderAction>
	);
}

/** The header's line about the change: who merged or released it, or who wants to merge it. */
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
				<strong>{agent}</strong> merged {branchCode} into {into} {timeAgo(ending.release.at)}
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
			<strong>{agent}</strong> wants to merge {branchCode} into {into}
			{record?.since ? <span className="text-muted-foreground"> · opened {timeAgo(record.since)}</span> : null}
		</>
	);
}

/** Beside the conversation's column, indented past its avatars; flush with it on a narrow window. */
const INDENT = "ml-11 to-720:ml-0";

/** A question the change's agent put to people, answered by voting. */
function AttentionCallout({ attention }: { attention: NonNullable<Claim["attention"]> }) {
	return (
		<Callout tone="needs" role="status" className={INDENT}>
			<Icon name="alert" className="text-needs" />
			<div>
				<strong>{attention.agent} asks you</strong>
				<p>{attention.reason}</p>
				<p className="text-muted-foreground">
					Decide with your vote below: it counts like a reviewer's and answers the question.
				</p>
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

function approvalIcon(approval: Claim["approval"]): IconName {
	if (approval.approved) return "check";
	if (approval.vetoedBy.length) return "x";
	return "eye";
}

/** The merge box's lamp, by how the change stands; neutral, or the link's tone, is grey. */
const MERGE_ICON: Partial<Record<Tone, string>> = {
	good: "bg-good text-good-foreground",
	bad: "bg-bad text-bad-foreground",
	warn: "bg-warn-soft text-warn",
	needs: "bg-needs text-needs-foreground",
};

/** The box under the conversation saying where the change stands: its lamp, a line in bold, and a muted line. */
function MergeBox({
	tone,
	icon,
	merged = false,
	title,
	children,
}: {
	tone: Tone;
	icon: IconName;
	merged?: boolean;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className={cn("relative rounded-md border border-border bg-card", INDENT, merged && "border-good/45")}
			aria-label="Merge status"
		>
			<div className="flex items-start gap-3 px-4 py-3">
				<span
					className={cn(
						"inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-neutral-soft text-neutral",
						"transition-colors duration-base",
						MERGE_ICON[tone],
					)}
					aria-hidden="true"
				>
					<Icon name={icon} />
				</span>
				<div className="min-w-0 pt-0.75 wrap-anywhere">
					<strong>{title}</strong>
					<div className="mt-px text-ui text-muted-foreground">{children}</div>
				</div>
			</div>
		</section>
	);
}

/** Where a change in force stands: its approvals, and what it waits on. */
function ClaimMergeBox({ claim }: { claim: Claim }) {
	const { approval } = claim;
	const approvalLabel = claimApprovalLabel(claim);
	const waitingNote = !approval.approved && approvalLabel.startsWith("Waiting") ? ` · ${approvalLabel}` : "";
	return (
		<MergeBox
			tone={claimStatus(claim).tone}
			icon={approvalIcon(approval)}
			title={
				claim.trusted ? (
					approvalLabel
				) : (
					<>
						{approval.approvals} of {approval.required} approvals
						{waitingNote}
					</>
				)
			}
		>
			{claim.attention
				? `Waiting on your decision: ${claim.attention.agent}'s question is above.`
				: claimStatus(claim).description}
		</MergeBox>
	);
}

/** How a change that's no longer in force ended: merged, or its claim released. */
function EndingMergeBox({ ending, branch, repo }: { ending: ChangeEnding; branch: string; repo: string }) {
	const merged = ending.kind === "merged";
	return (
		<MergeBox
			tone={merged ? "good" : "neutral"}
			icon={merged ? "merge" : "ban"}
			merged={merged}
			title={merged ? `Merged into ${branch}` : "Claim released"}
		>
			{merged ? (
				<>
					As{" "}
					<a href={href.code(repo, "", ending.release.mergedAs)}>
						<code>{shortSha(ending.release.mergedAs)}</code>
					</a>
					.
				</>
			) : (
				ending.release.reason || "Its paths are free again."
			)}
		</MergeBox>
	);
}

function MergeStatus({
	claim,
	ending,
	branch,
	repo,
}: {
	claim: Claim | undefined;
	ending: ChangeEnding | null;
	branch: string;
	repo: string;
}) {
	if (claim) return <ClaimMergeBox claim={claim} />;
	if (ending) return <EndingMergeBox ending={ending} branch={branch} repo={repo} />;
	return null;
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
				className="absolute top-3 -left-11 inline-flex size-8 items-center justify-center rounded-full bg-link-soft text-[#b86e00] to-720:hidden"
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
			<div className="p-3.5 whitespace-pre-wrap wrap-anywhere">
				{record?.intent || <span className="text-muted-foreground">No description provided.</span>}
			</div>
		</article>
	);
}

/** A branch named in the header, in the link's blue. */
const BRANCH = "bg-link-soft text-caption text-link";

/** A change, shown like a pull request: in force, merged or released. */
export function ChangePage({
	snapshot,
	changeId,
	claim,
	history,
	repo,
	tab,
	api,
	canVote = true,
	merge,
	giveUp,
	now,
	previewable = false,
}: ChangePageProps) {
	const branch = claim?.into || history?.branch || snapshot.branch || "main";
	const record = claim ?? history?.claim ?? undefined;
	const ending = history ? changeEnding(history) : null;
	const status = statusOf(claim, history);
	const agent = record?.agent || ending?.release.agent || identityName(record?.by) || "agent";
	const title = (record?.intent ?? "").split("\n")[0]?.trim() || changeId;
	const votes = claim ? votesForClaim(claim, history?.votes ?? snapshot.votes) : (history?.votes ?? []);
	// A change merging a whole branch shows that branch; any other, its own.
	const branchCode = <code className={BRANCH}>{claim?.source ?? `changes/${changeId}`}</code>;
	const into = <code className={BRANCH}>{branch}</code>;
	const timeline = history ? buildTimeline(history, repo).filter((item) => item.kind !== "opened") : [];
	const mergeable = claim && merge && claim.approval.approved && !claim.waitsOn?.length;
	// What comes once it's read fades in: the change in place of "Loading…", its history in place of the latest push,
	// and the other tab's content; what's there from the start comes with the page's own fade.
	const missing = !record && !ending;
	const pageFades = useChanged(missing);
	const historyFades = useChanged(history === undefined);
	const tabFades = useChanged(tab);

	if (missing)
		return <ChangeMissing changeId={changeId} repo={repo} loading={history === undefined} fades={historyFades} />;
	const loaded = historyFades && "animate-fade";

	// What its agent hears about it while its claim is in force: a conflict with its branch, and other changes' code.
	const heard =
		claim && history ? (
			<>
				{history.merge ? (
					<ConflictPanel merge={history.merge} head={claim.head} repo={repo} className={cn(INDENT, loaded)} />
				) : null}
				{history.awareness ? (
					<Awareness
						awareness={history.awareness}
						claims={snapshot.claims}
						head={claim.head}
						repo={repo}
						className={cn(INDENT, loaded)}
					/>
				) : null}
			</>
		) : null;

	const conversation = (
		<div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-8 to-900:grid-cols-[minmax(0,1fr)] to-900:gap-6">
			<div className="grid min-w-0 gap-3.5">
				{claim?.attention ? <AttentionCallout attention={claim.attention} /> : null}
				<OpeningComment agent={agent} record={record} />
				{history === undefined ? (
					<p className="m-0 ml-11 text-ui text-muted-foreground to-720:ml-0">Loading history…</p>
				) : null}
				{history ? <Timeline items={timeline} className={cn(loaded)} /> : <LatestPush head={claim?.head} />}
				{heard}
				{claim && api && canVote ? (
					<VoteForm repo={repo} claim={claim} policy={snapshot.policy} api={api} className={INDENT} />
				) : null}
				<MergeStatus claim={claim} ending={ending} branch={branch} repo={repo} />
			</div>
			<ChangeSidebar snapshot={snapshot} claim={claim} record={record} agent={agent} votes={votes} now={now} />
		</div>
	);
	const commits =
		history === null ? (
			<p className="my-[1em] text-muted-foreground">This change's commits couldn't be read.</p>
		) : (
			<ChangeCommits history={history} repo={repo} />
		);

	return (
		<div className={cn(pageFades && "animate-fade")}>
			<div className="pb-3.5">
				<h1 className="text-display leading-[1.25] font-medium tracking-[-0.01em] wrap-anywhere to-720:text-[21px]">
					{title} <span className="font-mono text-[0.72em] font-light text-muted-foreground">{changeId}</span>
				</h1>
				<div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-muted-foreground wrap-anywhere [&_strong]:text-foreground">
					{status ? <StatusPill status={status} size="lg" solid /> : null}
					<span>
						<ChangeHeadline agent={agent} ending={ending} record={record} branchCode={branchCode} into={into} />
					</span>
					{claim?.waitsOn?.length ? <Badge tone="warn">waits on {claim.waitsOn.join(", ")}</Badge> : null}
					{mergeable ? <MergeButton repo={repo} change={changeId} merge={merge} /> : null}
					{previewable && claim?.head ? <SiteLink repo={repo} change={changeId} /> : null}
					{claim && giveUp && isGitHubClaim(claim) ? (
						<GiveUpButton repo={repo} change={changeId} giveUp={giveUp} />
					) : null}
				</div>
			</div>
			<Tabs
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
				]}
			/>
			<div key={tab} className={cn("pt-5", tabFades && "animate-fade")}>
				{tab === "commits" ? commits : conversation}
			</div>
		</div>
	);
}
