import { type ReactNode, useState } from "react";
import { messageOf } from "../lib/errors";
import { VoteForm, type VoteApi } from "./VoteForm";
import type { ChangeHistory, RepoSnapshot } from "../api";
import { identityName } from "../lib/agent";
import type { ChangeStatus } from "../lib/changeStatus";
import { claimApprovalLabel, claimStatus, votesForClaim, type Claim } from "../lib/claimStatus";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { buildTimeline, changeEnding, historyStatus } from "../lib/changeTimeline";
import { Awareness } from "./Awareness";
import { ChangeCommits } from "./Commits";
import { ConflictPanel } from "./ConflictPanel";
import { Icon, type IconName } from "./Icon";
import { Tabs } from "./Tabs";
import { Timeline } from "./Timeline";
import { ChangeSidebar, type ChangeRecord } from "./ChangeSidebar";
import { StatusPill } from "./StatusPill";
import "./ChangePage.css";
import "./ChangeActions.css";

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
	/** The time leases are told against (tests fix it). */
	now?: number;
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
		<div className="change-merge">
			<button type="button" className="primary" onClick={mergeChange} disabled={busy}>
				{busy ? "Merging… (its checks run first)" : "Merge"}
			</button>
			{outcome ? (
				<p className={outcome.ok ? "tone-good" : "error"} role="status">
					{outcome.text}
				</p>
			) : null}
		</div>
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
			{record?.since ? <span className="muted"> · opened {timeAgo(record.since)}</span> : null}
		</>
	);
}

/** A question the change's agent put to people, answered by voting. */
function AttentionCallout({ attention }: { attention: NonNullable<Claim["attention"]> }) {
	return (
		<div className="callout callout--needs" role="status">
			<Icon name="alert" className="tone-needs" />
			<div>
				<strong>{attention.agent} asks you</strong>
				<p>{attention.reason}</p>
				<p className="muted">Decide with your vote below: it counts like a reviewer's and answers the question.</p>
			</div>
		</div>
	);
}

/** Before the history is in: the latest push only. */
function LatestPush({ head }: { head: string | null | undefined }) {
	return (
		<ol className="timeline">
			<li className="timeline__item">
				<span className="timeline__badge" aria-hidden="true">
					<Icon name="commit" size={14} />
				</span>
				<div className="timeline__content">
					<p className="timeline__line">
						{head ? (
							<>
								latest push <code className="timeline__sha">{shortSha(head)}</code>
							</>
						) : (
							"nothing pushed yet"
						)}
					</p>
				</div>
			</li>
		</ol>
	);
}

function approvalIcon(approval: Claim["approval"]): IconName {
	if (approval.approved) return "check";
	if (approval.vetoedBy.length) return "x";
	return "eye";
}

/** Where a change in force stands: its approvals, and what it waits on. */
function ClaimMergeBox({ claim }: { claim: Claim }) {
	const { approval } = claim;
	const approvalLabel = claimApprovalLabel(claim);
	const waitingNote = !approval.approved && approvalLabel.startsWith("Waiting") ? ` · ${approvalLabel}` : "";
	return (
		<section className="merge-box" aria-label="Merge status">
			<div className="merge-box__row">
				<span className={`merge-box__icon merge-box__icon--${claimStatus(claim).tone}`} aria-hidden="true">
					<Icon name={approvalIcon(approval)} />
				</span>
				<div className="merge-box__text">
					<strong>
						{approval.approvals} of {approval.required} approvals
						{waitingNote}
					</strong>
					<div className="muted">
						{claim.attention
							? `Waiting on your decision: ${claim.attention.agent}'s question is above.`
							: claimStatus(claim).description}
					</div>
				</div>
			</div>
		</section>
	);
}

/** How a change that's no longer in force ended: merged, or its claim released. */
function EndingMergeBox({ ending, branch, repo }: { ending: ChangeEnding; branch: string; repo: string }) {
	const merged = ending.kind === "merged";
	return (
		<section className={`merge-box${merged ? " merge-box--merged" : ""}`} aria-label="Merge status">
			<div className="merge-box__row">
				<span className={`merge-box__icon merge-box__icon--${merged ? "good" : "neutral"}`} aria-hidden="true">
					<Icon name={merged ? "merge" : "ban"} />
				</span>
				<div className="merge-box__text">
					<strong>{merged ? `Merged into ${branch}` : "Claim released"}</strong>
					<div className="muted">
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
					</div>
				</div>
			</div>
		</section>
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
function ChangeMissing({ changeId, repo, loading }: { changeId: string; repo: string; loading: boolean }) {
	if (loading)
		return (
			<p className="muted" role="status">
				Loading {changeId}…
			</p>
		);
	return (
		<div className="box empty">
			<Icon name="alert" size={28} className="muted" />
			<h2>Change not found</h2>
			<p>
				{repo} has no change named <code>{changeId}</code>. <a href={href.repo(repo, "changes")}>See open changes</a>.
			</p>
		</div>
	);
}

/** The agent's opening of the change: when, which paths it claims, and its intent. */
function OpeningComment({ agent, record }: { agent: string; record: ChangeRecord | undefined }) {
	return (
		<article className="comment comment--outside">
			<div className="comment__header">
				<strong>{agent}</strong>{" "}
				<span className="muted">
					opened this change{record?.since ? ` ${timeAgo(record.since)}` : ""}
					{record?.paths.length ? ` · claims ${record.paths.join(", ")}` : ""}
				</span>
			</div>
			<div className="comment__body">{record?.intent || <span className="muted">No description provided.</span>}</div>
		</article>
	);
}

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
	now,
}: ChangePageProps) {
	const branch = claim?.into || history?.branch || snapshot.branch || "main";
	const record = claim ?? history?.claim ?? undefined;
	const ending = history ? changeEnding(history) : null;
	const status = statusOf(claim, history);
	const agent = record?.agent || ending?.release.agent || identityName(record?.by) || "agent";
	const title = (record?.intent ?? "").split("\n")[0]?.trim() || changeId;
	const votes = claim ? votesForClaim(claim, history?.votes ?? snapshot.votes) : (history?.votes ?? []);
	// A change merging a whole branch shows that branch; any other, its own.
	const branchCode = <code className="change-header__branch">{claim?.source ?? `changes/${changeId}`}</code>;
	const into = <code className="change-header__branch">{branch}</code>;
	const timeline = history ? buildTimeline(history, repo).filter((item) => item.kind !== "opened") : [];
	const mergeable = claim && merge && claim.approval.approved && !claim.waitsOn?.length;

	if (!record && !ending) return <ChangeMissing changeId={changeId} repo={repo} loading={history === undefined} />;

	// What its agent hears about it while its claim is in force: a conflict with its branch, and other changes' code.
	const heard =
		claim && history ? (
			<>
				{history.merge ? <ConflictPanel merge={history.merge} head={claim.head} repo={repo} /> : null}
				{history.awareness ? (
					<Awareness awareness={history.awareness} claims={snapshot.claims} head={claim.head} repo={repo} />
				) : null}
			</>
		) : null;

	const conversation = (
		<div className="change-layout">
			<div className="change-layout__main">
				{claim?.attention ? <AttentionCallout attention={claim.attention} /> : null}
				<OpeningComment agent={agent} record={record} />
				{history === undefined ? <p className="muted change-layout__loading">Loading history…</p> : null}
				{history ? <Timeline items={timeline} /> : <LatestPush head={claim?.head} />}
				{heard}
				{claim && api && canVote ? <VoteForm repo={repo} claim={claim} policy={snapshot.policy} api={api} /> : null}
				<MergeStatus claim={claim} ending={ending} branch={branch} repo={repo} />
			</div>
			<ChangeSidebar snapshot={snapshot} claim={claim} record={record} agent={agent} votes={votes} now={now} />
		</div>
	);
	const commits =
		history === null ? (
			<p className="muted">This change's commits couldn't be read.</p>
		) : (
			<ChangeCommits history={history} repo={repo} />
		);

	return (
		<div className="change-page">
			<div className="change-header">
				<h1 className="change-header__title">
					{title} <span className="change-header__id">{changeId}</span>
				</h1>
				<div className="change-header__meta">
					{status ? <StatusPill status={status} size="lg" solid /> : null}
					<span>
						<ChangeHeadline agent={agent} ending={ending} record={record} branchCode={branchCode} into={into} />
					</span>
					{claim?.waitsOn?.length ? <span className="pill pill--warn">waits on {claim.waitsOn.join(", ")}</span> : null}
					{mergeable ? <MergeButton repo={repo} change={changeId} merge={merge} /> : null}
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
			<div className="change-page__body">{tab === "commits" ? commits : conversation}</div>
		</div>
	);
}
