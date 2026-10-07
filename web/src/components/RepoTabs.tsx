import { VoteForm, type VoteApi } from "./VoteForm";
import type { RepoAudit, ChangeHistory, RepoSnapshot } from "../api";
import { identityName } from "../lib/agent";
import { claimAgent, claimApprovalLabel, claimTitle, blockingRoles, claimStatus, shardingSummary, votesForClaim, votesShardingSummary, type Claim } from "../lib/claimStatus";
import { shortSha, briefPaths } from "../lib/model";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { buildTimeline, changeEnding, historyStatus } from "../lib/changeTimeline";
import { ChangeCommits } from "./Commits";
import { Icon } from "./Icon";
import { Tabs } from "./Tabs";
import { Timeline } from "./Timeline";
import { StatusIcon, StatusPill, TonePill } from "./StatusPill";
import "./ChangeList.css";
import "./ChangePage.css";
import "./ChangeActions.css";
import "./ChangeSidebar.css";
import "./RepoSettings.css";
import "./Timeline.css";
import "./RepoTabs.css";

// No central server enforces a repo's rules, so these pages show who holds what, how reviews stand, and what the audit read from
// Git found, including violations a revert has since resolved.

function Approvals({ claim }: { claim: Claim }) {
	const { approval } = claim;
	if (!claim.head) return null;
	const tone = approval.vetoedBy.length ? "bad" : approval.approved ? "good" : "warn";
	return (
		<span className={`inline-badge tone-${tone}`} title={`${approval.approvals} of ${approval.required} approvals`}>
			<Icon name={approval.vetoedBy.length ? "x" : approval.approved ? "check" : "eye"} size={14} />
			{claimApprovalLabel(claim)}
		</span>
	);
}

/** The Changes tab: claims in force, each a change in progress. */
export function ChangeList({ snapshot, repo }: { snapshot: RepoSnapshot; repo: string }) {
	const claims = [...snapshot.claims].sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
	return (
		<section className="box change-list" aria-labelledby="changes-title">
			<div className="box__header change-list__filters">
				<h2 id="changes-title" className="change-list__filter" aria-current="page">
					<Icon name="pull" />
					<span className="change-list__count">{claims.length}</span> Open
				</h2>
				{snapshot.audit ? (
					<span className="change-list__filter">
						<Icon name="merge" />
						<span className="change-list__count">{snapshot.audit.merges}</span> merged on {snapshot.branch ?? "main"}
					</span>
				) : null}
			</div>
			{claims.length === 0 ? (
				<div className="empty">
					<Icon name="pull" size={28} className="muted" />
					<h2>No open changes</h2>
					<p>When an agent claims part of {repo} and starts work, its change appears here.</p>
				</div>
			) : (
				<ul className="change-list__rows">
					{claims.map((claim) => {
						const status = claimStatus(claim);
						return (
							<li key={claim.change} className="change-row">
								<StatusIcon status={status} />
								<div className="change-row__main">
									<div className="change-row__title">
										<a href={href.change(repo, claim.change)}>{claimTitle(claim)}</a>
										{status.kind !== "in-review" ? <StatusPill status={status} /> : null}
									</div>
									<p className="change-row__meta">
										<span className="change-row__id">{claim.change}</span>
										<span>
											{" · "}opened {timeAgo(claim.since)} by {claimAgent(claim)}
										</span>
										{claim.paths.length ? (
											<span className="change-row__paths">
												{" · "}
												<Icon name="folder" size={12} />
												<span title={claim.paths.join("\n")}>{briefPaths(claim.paths)}</span>
											</span>
										) : null}
									</p>
								</div>
								<div className="change-row__aside">
									<Approvals claim={claim} />
									{claim.head ? <code className="muted">{shortSha(claim.head)}</code> : null}
									<time className="change-row__age muted" dateTime={claim.active} title={`Last active ${new Date(claim.active).toLocaleString()}`}>
										{shortAge(claim.active)}
									</time>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function Violations({ title, violations }: { title: string; violations: RepoAudit["violations"] }) {
	return (
		<section className="box">
			<div className="box__header">
				<h3>{title}</h3>
				<span className="counter">{violations.length}</span>
			</div>
			<ul className="audit-violations">
				{violations.map((v, i) => (
					<li key={`${v.commit}-${v.rule}-${i}`} className={`box__row audit-violation${v.resolvedBy ? " audit-violation--resolved" : ""}`}>
						<span className={v.resolvedBy ? "tone-neutral" : "tone-bad"}>
							<Icon name={v.resolvedBy ? "check-circle" : "alert"} />
						</span>
						<div>
							<p>
								<strong>{v.rule}</strong> by {v.author}
								<span className="muted"> ({v.by ? identityName(v.by) : "unverified"})</span> in <code>{shortSha(v.commit)}</code>
							</p>
							<p className="muted">{v.detail}</p>
							{v.resolvedBy ? <p className="muted">resolved by {shortSha(v.resolvedBy)}</p> : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The Audit tab: rules broken on the project's branch, read from Git, and the reviews recorded. */
export function AuditTab({ snapshot }: { snapshot: RepoSnapshot }) {
	const { audit, votes } = snapshot;
	if (!audit)
		return (
			<p className="muted page__loading" role="status">
				Replaying the records from Git…
			</p>
		);
	const open = audit.violations.filter((v) => !v.resolvedBy);
	const resolved = audit.violations.filter((v) => v.resolvedBy);
	return (
		<div className="audit">
			<div className={`callout ${open.length ? "callout--bad" : "callout--good"}`}>
				<Icon name={open.length ? "alert" : "check-circle"} className={open.length ? "tone-bad" : "tone-good"} />
				<div>
					<strong>{open.length ? `${open.length} open ${open.length === 1 ? "violation" : "violations"}` : "No open violations"}</strong>
					<p className="muted">
						{audit.merges} {audit.merges === 1 ? "commit" : "commits"} on {snapshot.branch ?? "main"} since the mode started.
						{audit.violations.length === 0 ? " No violations." : ""}
					</p>
				</div>
			</div>
			{open.length > 0 ? <Violations title="Open" violations={open} /> : null}
			{resolved.length > 0 ? <Violations title="Resolved" violations={resolved} /> : null}
			<section className="box">
				<div className="box__header">
					<h3>Recent reviews</h3>
				</div>
				{votes.length === 0 ? (
					<p className="box__row muted">No reviews yet.</p>
				) : (
					<ul className="audit-votes">
						{votes.map((v) => (
							<li key={`${v.reviewer}-${v.commit}-${v.at}`} className="box__row audit-vote">
								<span className={v.verdict === "approve" ? "tone-good" : "tone-bad"}>
									<Icon name={v.verdict === "approve" ? "check" : "x"} />
								</span>
								<div>
									<p>
										<strong>{v.reviewer}</strong> <span className="muted">({v.role})</span> {v.verdict === "approve" ? "approved" : "rejected"} <code>{shortSha(v.commit)}</code>
										{v.by ? <span className="muted"> · {identityName(v.by)}</span> : null}
										<span className="muted"> · {timeAgo(v.at)}</span>
									</p>
									{v.evidence ? <p className="muted audit-vote__evidence">{v.evidence}</p> : null}
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

/** The Settings tab: the conventions agents agreed to follow. Read-only. */
export function SettingsTab({ snapshot }: { snapshot: RepoSnapshot }) {
	const { policy, verify } = snapshot;
	const sharding = shardingSummary(snapshot);
	const votesSharding = votesShardingSummary(snapshot);
	return (
		<div className="repo-settings">
			<p className="callout repo-settings__intro">
				<Icon name="alert" className="muted" />
				<span>
					These settings can't be changed here. A repo's rules are set once, when it starts (the MCP <code>start</code> tool), and every agent checks them itself.
				</span>
			</p>
			<section className="box">
				<div className="box__header">
					<h2>How changes merge</h2>
				</div>
				<div className="box__body">
					<dl className="repo-settings__list">
						<dt>Approvals</dt>
						<dd>
							Merging needs {policy.required} {policy.required === 1 ? "approval" : "approvals"}
							{policy.vetoes.length ? `; ${policy.vetoes.join(", ")} can block` : ""}
						</dd>
						{blockingRoles(policy).length ? (
							<>
								<dt>Who can block</dt>
								<dd>
									{blockingRoles(policy)
										.map(({ role, holders }) => `${role}: ${holders}`)
										.join("; ")}
									. A vote as one of these roles from anyone else counts as an ordinary review.
								</dd>
							</>
						) : null}
						<dt>Merge checks</dt>
						<dd>{verify.length ? verify.map((c) => <code key={c}>{c}</code>) : "No checks before merging"}</dd>
						<dt>Signed records</dt>
						<dd>{snapshot.verified ? "Records and merges are stamped with verified identity" : "Records are not stamped: names are as agents give them"}</dd>
						{sharding ? (
							<>
								<dt>Claims</dt>
								<dd>{sharding.detail}</dd>
							</>
						) : null}
						{votesSharding ? (
							<>
								<dt>Votes</dt>
								<dd>{votesSharding.detail}</dd>
							</>
						) : null}
						<dt>Branches</dt>
						<dd>Each change works in its own fork: agents can't write {snapshot.branch ?? "main"}; only the toolkit merges, once the conventions hold.</dd>
					</dl>
				</div>
			</section>
		</div>
	);
}

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
}

/** A change, shown like a pull request: in force, merged or released. */
export function ChangePage({ snapshot, changeId, claim, history, repo, tab, api }: ChangePageProps) {
	const branch = history?.branch || snapshot.branch || "main";
	const record = claim ?? history?.claim ?? undefined;
	const ending = history ? changeEnding(history) : null;
	const status = claim ? claimStatus(claim) : history ? historyStatus(history) : null;
	const agent = record?.agent || ending?.release.agent || identityName(record?.by) || "agent";
	const title = (record?.intent ?? "").split("\n")[0].trim() || changeId;
	const votes = claim ? votesForClaim(claim, history?.votes ?? snapshot.votes) : (history?.votes ?? []);
	const builder = claim?.hosted?.builder;
	const branchCode = <code className="change-header__branch">changes/{changeId}</code>;
	const into = <code className="change-header__branch">{branch}</code>;
	const timeline = history ? buildTimeline(history, repo).filter((item) => item.kind !== "opened") : [];

	if (!record && !ending) {
		if (history === undefined)
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
					{repo} has no change named <code>{changeId}</code>. <a href={href.repo(repo)}>See open changes</a>.
				</p>
			</div>
		);
	}

	return (
		<div className="change-page">
			<div className="change-header">
				<h1 className="change-header__title">
					{title} <span className="change-header__id">{changeId}</span>
				</h1>
				<div className="change-header__meta">
					{status ? <StatusPill status={status} size="lg" solid /> : null}
					<span>
						{ending?.kind === "merged" ? (
							<>
								<strong>{agent}</strong> merged {branchCode} into {into} {timeAgo(ending.release.at)}
							</>
						) : ending ? (
							<>
								<strong>{agent}</strong>’s change {branchCode} was released {timeAgo(ending.release.at)}
							</>
						) : (
							<>
								<strong>{agent}</strong> wants to merge {branchCode} into {into}
								{record?.since ? <span className="muted"> · opened {timeAgo(record.since)}</span> : null}
							</>
						)}
					</span>
				</div>
			</div>
			<Tabs
				label="Change sections"
				current={tab}
				items={[
					{ id: "conversation", label: "Conversation", icon: "comment", href: href.change(repo, changeId) },
					{ id: "commits", label: "Commits", icon: "commit", href: href.change(repo, changeId, "commits"), count: history?.commits.length },
				]}
			/>
			<div className="change-page__body">
				{tab === "commits" ? (
					history === null ? (
						<p className="muted">This change's commits couldn't be read.</p>
					) : (
						<ChangeCommits history={history} repo={repo} />
					)
				) : (
					<div className="change-layout">
						<div className="change-layout__main">
							{claim?.attention ? (
								<div className="callout callout--needs" role="status">
									<Icon name="alert" className="tone-needs" />
									<div>
										<strong>{claim.attention.agent} asks you</strong>
										<p>{claim.attention.reason}</p>
										<p className="muted">Decide with your vote below: it counts like a reviewer's and answers the question.</p>
									</div>
								</div>
							) : null}
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
							{history === undefined ? <p className="muted change-layout__loading">Loading history…</p> : null}
							{history ? (
								<Timeline items={timeline} />
							) : (
								<ol className="timeline">
									<li className="timeline__item">
										<span className="timeline__badge" aria-hidden="true">
											<Icon name="commit" size={14} />
										</span>
										<div className="timeline__content">
											<p className="timeline__line">{claim?.head ? <>latest push <code className="timeline__sha">{shortSha(claim.head)}</code></> : "nothing pushed yet"}</p>
										</div>
									</li>
								</ol>
							)}
							{claim && api ? <VoteForm repo={repo} claim={claim} policy={snapshot.policy} api={api} /> : null}
							{claim ? (
								<section className="merge-box" aria-label="Merge status">
									<div className="merge-box__row">
										<span className={`merge-box__icon merge-box__icon--${claimStatus(claim).tone}`} aria-hidden="true">
											<Icon name={claim.approval.approved ? "check" : claim.approval.vetoedBy.length ? "x" : "eye"} />
										</span>
										<div className="merge-box__text">
											<strong>
												{claim.approval.approvals} of {claim.approval.required} approvals{claim.approval.approved ? "" : claimApprovalLabel(claim).startsWith("Waiting") ? ` · ${claimApprovalLabel(claim)}` : ""}
											</strong>
											<div className="muted">{claim.attention ? `Waiting on your decision: ${claim.attention.agent}'s question is above.` : claimStatus(claim).description}</div>
										</div>
									</div>
								</section>
							) : ending ? (
								<section className={`merge-box${ending.kind === "merged" ? " merge-box--merged" : ""}`} aria-label="Merge status">
									<div className="merge-box__row">
										<span className={`merge-box__icon merge-box__icon--${ending.kind === "merged" ? "good" : "neutral"}`} aria-hidden="true">
											<Icon name={ending.kind === "merged" ? "merge" : "ban"} />
										</span>
										<div className="merge-box__text">
											<strong>{ending.kind === "merged" ? `Merged into ${branch}` : "Claim released"}</strong>
											<div className="muted">
												{ending.kind === "merged" ? (
													<>
														As <a href={href.code(repo, "", ending.release.mergedAs)}>
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
							) : null}
						</div>
						<aside className="change-sidebar" aria-label="Change details">
							<section className="sidebar-section">
								<h2>Reviewers</h2>
								{claim?.hosted?.reviewers.length ? (
									<ul className="sidebar-reviewers">
										{claim.hosted.reviewers.map((r) => (
											<li key={r.role}>
												<span className="sidebar-reviewers__role">
													<Icon name="shield" size={14} className="muted" />
													{r.role}
												</span>
												<span className={`sidebar-reviewers__state tone-${r.verdict === "approve" ? "good" : r.verdict === "reject" ? "bad" : "neutral"}`}>{r.verdict ?? r.status}</span>
											</li>
										))}
									</ul>
								) : (
									<p className="muted">{votes.length ? `${votes.length} ${votes.length === 1 ? "review" : "reviews"}` : "No reviews yet."}</p>
								)}
								<p className="muted sidebar-note">{snapshot.policy.required} approvals required</p>
							</section>
							<section className="sidebar-section">
								<h2>Agent</h2>
								<p className="sidebar-agent">
									<Icon name={builder ? "bot" : "user"} size={14} className="muted" />
									<strong>{agent}</strong>
									{record?.by && identityName(record.by) !== agent ? <span className="muted"> · {identityName(record.by)}</span> : null}
								</p>
								{builder ? (
									<p className={`sidebar-small tone-${builder.status === "failed" ? "bad" : "neutral"}`}>
										Builder {builder.status}
										{builder.revisions ? ` (revision ${builder.revisions})` : ""}
										{builder.error ? `: ${builder.error}` : ""}
									</p>
								) : null}
								{claim ? <p className="muted sidebar-small">Last active {timeAgo(claim.active)}</p> : null}
							</section>
							<section className="sidebar-section">
								<h2>Claim</h2>
								{record?.paths.length ? (
									<ul className="sidebar-paths">
										{record.paths.map((path) => (
											<li key={path}>
												<Icon name="folder" size={13} className="muted" />
												<code>{path}</code>
											</li>
										))}
									</ul>
								) : (
									<p className="muted">Released.</p>
								)}
							</section>
							{claim?.approval.vetoedBy.length ? (
								<section className="sidebar-section">
									<TonePill tone="bad" icon="x">
										Blocked by {claim.approval.vetoedBy.join(", ")}
									</TonePill>
								</section>
							) : null}
						</aside>
					</div>
				)}
			</div>
		</div>
	);
}
