import type { FreeAudit, FreeSnapshot } from "../api";
import { identityName } from "../lib/agent";
import { claimAgent, claimApprovalLabel, claimTitle, freeClaimStatus, votesForClaim, type FreeClaim } from "../lib/freeStatus";
import { shortSha } from "../lib/model";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href, type RepoBase } from "../lib/routes";
import { Icon } from "./Icon";
import { StatusIcon, StatusPill, TonePill } from "./StatusPill";
import "./ChangeList.css";
import "./ChangePage.css";
import "./ChangeActions.css";
import "./ChangeSidebar.css";
import "./RepoSettings.css";
import "./Timeline.css";
import "./FreeRepo.css";

// A repo in coordinator-free mode: nothing enforces the rules there, so these
// pages show who holds what, how reviews stand, and what the audit read from
// Git found, including violations a revert has since resolved.

function Approvals({ claim }: { claim: FreeClaim }) {
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
export function FreeChangeList({ snapshot, repo, base }: { snapshot: FreeSnapshot; repo: string; base: RepoBase }) {
	const claims = [...snapshot.claims].sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
	return (
		<section className="box change-list" aria-labelledby="free-changes-title">
			<div className="box__header change-list__filters">
				<h2 id="free-changes-title" className="change-list__filter" aria-current="page">
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
						const status = freeClaimStatus(claim);
						return (
							<li key={claim.change} className="change-row">
								<StatusIcon status={status} />
								<div className="change-row__main">
									<div className="change-row__title">
										<a href={href.change(repo, claim.change, "conversation", base)}>{claimTitle(claim)}</a>
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
												{claim.paths.join(", ")}
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

function Violations({ title, violations }: { title: string; violations: FreeAudit["violations"] }) {
	return (
		<section className="box">
			<div className="box__header">
				<h3>{title}</h3>
				<span className="counter">{violations.length}</span>
			</div>
			<ul className="free-violations">
				{violations.map((v, i) => (
					<li key={`${v.commit}-${v.rule}-${i}`} className={`box__row free-violation${v.resolvedBy ? " free-violation--resolved" : ""}`}>
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
export function FreeAudit({ snapshot }: { snapshot: FreeSnapshot }) {
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
		<div className="free-audit">
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
					<ul className="free-votes">
						{votes.map((v) => (
							<li key={`${v.reviewer}-${v.commit}-${v.at}`} className="box__row free-vote">
								<span className={v.verdict === "approve" ? "tone-good" : "tone-bad"}>
									<Icon name={v.verdict === "approve" ? "check" : "x"} />
								</span>
								<div>
									<p>
										<strong>{v.reviewer}</strong> <span className="muted">({v.role})</span> {v.verdict === "approve" ? "approved" : "rejected"} <code>{shortSha(v.commit)}</code>
										{v.by ? <span className="muted"> · {identityName(v.by)}</span> : null}
										<span className="muted"> · {timeAgo(v.at)}</span>
									</p>
									{v.evidence ? <p className="muted free-vote__evidence">{v.evidence}</p> : null}
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
export function FreeSettings({ snapshot }: { snapshot: FreeSnapshot }) {
	const { policy, verify } = snapshot;
	return (
		<div className="repo-settings">
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
						<dt>Merge checks</dt>
						<dd>{verify.length ? verify.map((c) => <code key={c}>{c}</code>) : "No checks before merging"}</dd>
						<dt>Signed records</dt>
						<dd>{snapshot.verified ? "Records and merges are stamped with verified identity" : "Records are not stamped: names are as agents give them"}</dd>
						<dt>Branches</dt>
						<dd>Each change works in its own fork: agents can't write {snapshot.branch ?? "main"}; only the toolkit merges, once the conventions hold.</dd>
					</dl>
				</div>
			</section>
		</div>
	);
}

/** A claimed change, shown like a pull request. */
export function FreeChangePage({ snapshot, claim }: { snapshot: FreeSnapshot; claim: FreeClaim }) {
	const status = freeClaimStatus(claim);
	const votes = votesForClaim(claim, snapshot.votes);
	const builder = claim.hosted?.builder;
	return (
		<div className="change-page">
			<div className="change-header">
				<h1 className="change-header__title">
					{claimTitle(claim)} <span className="change-header__id">{claim.change}</span>
				</h1>
				<div className="change-header__meta">
					<StatusPill status={status} size="lg" solid />
					<span>
						<strong>{claimAgent(claim)}</strong> wants to merge <code className="change-header__branch">changes/{claim.change}</code> into{" "}
						<code className="change-header__branch">{snapshot.branch ?? "main"}</code>
						<span className="muted"> · opened {timeAgo(claim.since)}</span>
					</span>
				</div>
			</div>
			<div className="change-page__body change-page__body--bordered">
				<div className="change-layout">
					<div className="change-layout__main">
						<article className="comment">
							<div className="comment__header">
								<strong>{claimAgent(claim)}</strong> <span className="muted">opened this change {timeAgo(claim.since)} · claims {claim.paths.join(", ")}</span>
							</div>
							<div className="comment__body">{claim.intent || <span className="muted">No description provided.</span>}</div>
						</article>
						<ol className="timeline">
							<li className="timeline__item">
								<span className="timeline__badge" aria-hidden="true">
									<Icon name="commit" size={14} />
								</span>
								<div className="timeline__content">
									<p className="timeline__line">{claim.head ? <>latest push <code className="timeline__sha">{shortSha(claim.head)}</code></> : "nothing pushed yet"}</p>
								</div>
							</li>
							{votes.map((v) => (
								<li key={`${v.reviewer}-${v.at}`} className="timeline__item timeline__item--review">
									<span className={`timeline__badge timeline__badge--${v.verdict === "approve" ? "good" : "bad"}`} aria-hidden="true">
										<Icon name={v.verdict === "approve" ? "check" : "x"} size={14} />
									</span>
									<div className="timeline__content">
										<div className={`timeline-card timeline-card--${v.verdict === "approve" ? "good" : "bad"}`}>
											<div className="timeline-card__header">
												<strong>{v.reviewer}</strong> ({v.role}) {v.verdict === "approve" ? "approved these changes" : "requested changes"}
												<span className="muted"> · {timeAgo(v.at)}</span>
											</div>
											{v.evidence ? <div className="timeline-card__body">{v.evidence}</div> : null}
										</div>
									</div>
								</li>
							))}
						</ol>
						<section className="merge-box" aria-label="Merge status">
							<div className="merge-box__row">
								<span className={`merge-box__icon merge-box__icon--${status.tone}`} aria-hidden="true">
									<Icon name={claim.approval.approved ? "check" : claim.approval.vetoedBy.length ? "x" : "eye"} />
								</span>
								<div className="merge-box__text">
									<strong>
										{claim.approval.approvals} of {claim.approval.required} approvals{claim.approval.approved ? "" : claimApprovalLabel(claim).startsWith("Waiting") ? ` · ${claimApprovalLabel(claim)}` : ""}
									</strong>
									<div className="muted">{status.description}</div>
								</div>
							</div>
						</section>
					</div>
					<aside className="change-sidebar" aria-label="Change details">
						<section className="sidebar-section">
							<h2>Reviewers</h2>
							{claim.hosted?.reviewers.length ? (
								<ul className="sidebar-reviewers">
									{claim.hosted.reviewers.map((r) => (
										<li key={r.role}>
											<span className="sidebar-reviewers__role">
												<Icon name="shield" size={14} className="muted" />
												{r.role}
											</span>
											<span className={`sidebar-reviewers__state tone-${r.verdict === "approve" ? "good" : r.verdict === "reject" ? "bad" : "neutral"}`}>
												{r.verdict ?? r.status}
											</span>
										</li>
									))}
								</ul>
							) : (
								<p className="muted">{votes.length ? `${votes.length} ${votes.length === 1 ? "review" : "reviews"} on this commit` : "No reviews yet."}</p>
							)}
							<p className="muted sidebar-note">{claim.approval.required} approvals required</p>
						</section>
						<section className="sidebar-section">
							<h2>Agent</h2>
							<p className="sidebar-agent">
								<Icon name={builder ? "bot" : "user"} size={14} className="muted" />
								<strong>{claimAgent(claim)}</strong>
								{claim.by && identityName(claim.by) !== claimAgent(claim) ? <span className="muted"> · {identityName(claim.by)}</span> : null}
							</p>
							{builder ? (
								<p className={`sidebar-small tone-${builder.status === "failed" ? "bad" : "neutral"}`}>
									Builder {builder.status}
									{builder.revisions ? ` (revision ${builder.revisions})` : ""}
									{builder.error ? `: ${builder.error}` : ""}
								</p>
							) : null}
							<p className="muted sidebar-small">Last active {timeAgo(claim.active)}</p>
						</section>
						<section className="sidebar-section">
							<h2>Claim</h2>
							<ul className="sidebar-paths">
								{claim.paths.map((path) => (
									<li key={path}>
										<Icon name="folder" size={13} className="muted" />
										<code>{path}</code>
									</li>
								))}
							</ul>
						</section>
						{claim.approval.vetoedBy.length ? (
							<section className="sidebar-section">
								<TonePill tone="bad" icon="x">
									Blocked by {claim.approval.vetoedBy.join(", ")}
								</TonePill>
							</section>
						) : null}
					</aside>
				</div>
			</div>
		</div>
	);
}
