import type { ReactNode } from "react";
import type { RepoAudit, RepoSnapshot } from "../api";
import { identityName } from "../lib/agent";
import type { Tone } from "../lib/changeStatus";
import {
	claimAgent,
	claimApprovalLabel,
	claimTitle,
	blockingRoles,
	claimStatus,
	isFromGitHub,
	shardingSummary,
	votesShardingSummary,
	type Claim,
} from "../lib/claimStatus";
import { leaseWords } from "../lib/lease";
import { shortSha, briefPaths } from "../lib/model";
import { counted } from "../lib/plural";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { Icon, type IconName } from "./Icon";
import { StatusIcon, StatusPill } from "./StatusPill";
import "./ChangeList.css";
import "./RepoSettings.css";
import "./RepoTabs.css";

export { ChangePage, type ChangePageProps } from "./ChangePage";

// No central server enforces a repo's rules, so these pages show who holds what, how reviews stand, and
// what the audit found in Git, including violations a revert has since resolved.

/** How a change's approvals look: blocked, approved, or still waiting. */
function approvalLook(approval: Claim["approval"]): { tone: Tone; icon: IconName } {
	if (approval.vetoedBy.length) return { tone: "bad", icon: "x" };
	if (approval.approved) return { tone: "good", icon: "check" };
	return { tone: "warn", icon: "eye" };
}

function Approvals({ claim }: { claim: Claim }) {
	const { approval } = claim;
	if (!claim.head) return null;
	const { tone, icon } = approvalLook(approval);
	return (
		<span className={`inline-badge tone-${tone}`} title={`${approval.approvals} of ${approval.required} approvals`}>
			<Icon name={icon} size={14} />
			{claimApprovalLabel(claim)}
		</span>
	);
}

/**
 * Where a change lands and what holds it back, when that isn't the plain case: into another branch, merging a
 * whole branch, or waiting on other changes.
 */
export function ChangeLabels({
	claim,
}: {
	claim: Pick<Claim, "into" | "source" | "waitsOn" | "trusted"> & { agent?: string };
}) {
	return (
		<>
			{isFromGitHub(claim) ? (
				<span className="pill pill--outline" title={claim.trusted ?? "GitHub's changes, reviewed like any change"}>
					from GitHub{claim.trusted ? ", trusted" : ""}
				</span>
			) : claim.source ? (
				<span className="pill pill--outline">
					merges <code>{claim.source}</code>
				</span>
			) : null}
			{claim.into ? (
				<span className="pill pill--outline">
					into <code>{claim.into}</code>
				</span>
			) : null}
			{claim.waitsOn?.length ? <span className="pill pill--warn">waits on {claim.waitsOn.join(", ")}</span> : null}
		</>
	);
}

/** One open change in the list: its status, title, who opened it, what it claims, when it frees up, and its approvals. */
function ChangeRow({ claim, repo, now }: { claim: Claim; repo: string; now?: number }) {
	const status = claimStatus(claim);
	// Only a claim on its agent's turn frees up, at a time; the change's page says why the others don't.
	const lease = leaseWords(claim.lease, now);
	return (
		<li className="change-row">
			<StatusIcon status={status} />
			<div className="change-row__main">
				<div className="change-row__title">
					<a href={href.change(repo, claim.change)}>{claimTitle(claim)}</a>
					{status.kind !== "in-review" ? <StatusPill status={status} /> : null}
					<ChangeLabels claim={claim} />
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
					{lease?.short ? (
						<span className={`change-row__lease${lease.free ? " tone-warn" : ""}`} title={lease.long}>
							{" · "}
							<Icon name="clock" size={12} />
							{lease.short}
						</span>
					) : null}
				</p>
			</div>
			<div className="change-row__aside">
				<Approvals claim={claim} />
				{claim.head ? <code className="muted">{shortSha(claim.head)}</code> : null}
				<time
					className="change-row__age muted"
					dateTime={claim.active}
					title={`Last active ${new Date(claim.active).toLocaleString()}`}
				>
					{shortAge(claim.active)}
				</time>
			</div>
		</li>
	);
}

/** The open changes, newest first: all of them, or those on `shown` (the branch the overview shows). */
export function ChangeList({
	snapshot,
	repo,
	shown,
	now,
}: {
	snapshot: RepoSnapshot;
	repo: string;
	shown?: string;
	/** The time leases are told against (tests fix it). */
	now?: number;
}) {
	const project = snapshot.branch ?? "main";
	const claims = [...snapshot.claims]
		.filter((claim) => !shown || (claim.into ?? project) === shown)
		.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
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
					{claims.map((claim) => (
						<ChangeRow key={claim.change} claim={claim} repo={repo} now={now} />
					))}
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
				{violations.map((violation, index) => (
					<li
						key={`${violation.commit}-${violation.rule}-${index}`}
						className={`box__row audit-violation${violation.resolvedBy ? " audit-violation--resolved" : ""}`}
					>
						<span className={violation.resolvedBy ? "tone-neutral" : "tone-bad"}>
							<Icon name={violation.resolvedBy ? "check-circle" : "alert"} />
						</span>
						<div>
							<p>
								<strong>{violation.rule}</strong> by {violation.author}
								<span className="muted"> ({violation.by ? identityName(violation.by) : "unverified"})</span> in{" "}
								<code>{shortSha(violation.commit)}</code>
							</p>
							<p className="muted">{violation.detail}</p>
							{violation.resolvedBy ? <p className="muted">resolved by {shortSha(violation.resolvedBy)}</p> : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The reviews recorded, newest as the snapshot lists them. */
function RecentReviews({ votes }: { votes: RepoSnapshot["votes"] }) {
	if (votes.length === 0) return <p className="box__row muted">No reviews yet.</p>;
	return (
		<ul className="audit-votes">
			{votes.map((vote) => (
				<li key={`${vote.reviewer}-${vote.commit}-${vote.at}`} className="box__row audit-vote">
					<span className={vote.verdict === "approve" ? "tone-good" : "tone-bad"}>
						<Icon name={vote.verdict === "approve" ? "check" : "x"} />
					</span>
					<div>
						<p>
							<strong>{vote.reviewer}</strong> <span className="muted">({vote.role})</span>{" "}
							{vote.verdict === "approve" ? "approved" : "rejected"} <code>{shortSha(vote.commit)}</code>
							{vote.by ? <span className="muted"> · {identityName(vote.by)}</span> : null}
							<span className="muted"> · {timeAgo(vote.at)}</span>
							{vote.thin ? <span className="muted"> · thin evidence</span> : null}
						</p>
						{vote.evidence ? <p className="muted audit-vote__evidence">{vote.evidence}</p> : null}
					</div>
				</li>
			))}
		</ul>
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
	const open = audit.violations.filter((violation) => !violation.resolvedBy);
	const resolved = audit.violations.filter((violation) => violation.resolvedBy);
	const openHeadline = open.length ? counted(open.length, "open violation") : "No open violations";
	return (
		<div className="audit">
			<div className={`callout ${open.length ? "callout--bad" : "callout--good"}`}>
				<Icon name={open.length ? "alert" : "check-circle"} className={open.length ? "tone-bad" : "tone-good"} />
				<div>
					<strong>{openHeadline}</strong>
					<p className="muted">
						{audit.merges} {audit.merges === 1 ? "commit" : "commits"} on {snapshot.branch ?? "main"} since GitHive
						started on it.
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
				<RecentReviews votes={votes} />
			</section>
		</div>
	);
}

type Policy = RepoSnapshot["policy"];
type PathRule = NonNullable<Policy["escalate"]>[number];

/** A stricter rule for paths, in words: what touching them needs. */
function ruleWords(rule: PathRule, required: number) {
	const approvals = rule.required ?? required;
	const approvalWords = `${approvals} ${approvals === 1 ? "approval" : "approvals"}`;
	const blockers = rule.vetoes?.length ? `; ${rule.vetoes.join(", ")} can block` : "";
	return `${approvalWords}${blockers}`;
}

/** How changes merge, as terms in the Settings tab's list: for readers who can't change it. */
function MergePolicyTerms({ policy, verify }: { policy: Policy; verify: string[] }) {
	const blockers = blockingRoles(policy);
	return (
		<>
			<dt>Approvals</dt>
			<dd>
				Merging needs {policy.required} {policy.required === 1 ? "approval" : "approvals"}
				{policy.vetoes.length ? `; ${policy.vetoes.join(", ")} can block` : ""}
			</dd>
			{blockers.length ? (
				<>
					<dt>Who can block</dt>
					<dd>
						{blockers.map(({ role, holders }) => `${role}: ${holders}`).join("; ")}. A vote as one of these roles from
						anyone else counts as an ordinary review.
					</dd>
				</>
			) : null}
			{policy.escalate?.length ? (
				<>
					<dt>Stricter paths</dt>
					<dd>
						<ul className="repo-settings__commands">
							{policy.escalate.map((rule, index) => (
								<li key={index}>
									{rule.paths.map((path) => (
										<code key={path}>{path}</code>
									))}{" "}
									need {ruleWords(rule, policy.required)}
								</li>
							))}
						</ul>
					</dd>
				</>
			) : null}
			<dt>Merge checks</dt>
			<dd>
				{verify.length
					? verify.map((command) => <code key={command}>{command}</code>)
					: "None: changes that merge cleanly but break together aren't caught"}
			</dd>
		</>
	);
}

/** The GitHub link in words: where GitHive's work goes, and whether GitHub's changes come back reviewed. */
export function githubTerms(github: NonNullable<RepoSnapshot["github"]>, branch: string) {
	const how =
		github.sync === "pr"
			? `GitHive's work reaches ${github.repo} through one pull request from githive/main, merged on GitHub`
			: `GitHive pushes ${branch} to ${github.repo} after every landing`;
	if (!github.inbound) return `${how}, as it did before modes: GitHub's changes aren't brought back.`;
	const back = github.trust
		? "GitHub's changes come back as githive-github's change, landing through the checks without review"
		: "GitHub's changes come back as githive-github's change, reviewed like any change";
	return `${how}. ${back}.`;
}

/**
 * The Settings tab: how changes merge (for the repo's admins, `editor` to
 * change it; for everyone else, what it is), how the records are kept, and
 * who may do what (`access`).
 */
export function SettingsTab({
	snapshot,
	access,
	editor,
}: {
	snapshot: RepoSnapshot;
	/** Who may do what: the reader's permission, visibility, collaborators. */ access?: ReactNode;
	/** For the repo's admins: the form that changes how changes merge. */ editor?: ReactNode;
}) {
	const { policy, verify } = snapshot;
	const sharding = shardingSummary(snapshot);
	const votesSharding = votesShardingSummary(snapshot);
	return (
		<div className="repo-settings">
			<p className="callout repo-settings__intro">
				<Icon name="alert" className="muted" />
				<span>
					{editor
						? "Changes here apply to merges from now on: each merge is audited against the " +
							"settings in force when it merged. Agents can change them too, with the MCP " +
							"settings tool."
						: "The repo's admins set how changes merge, and every agent checks it itself. A role " +
							"can be granted to a team, as @org/team."}
				</span>
			</p>
			{editor}
			<section className="box">
				<div className="box__header">
					<h2>{editor ? "How the records are kept" : "How changes merge"}</h2>
				</div>
				<div className="box__body">
					<dl className="repo-settings__list">
						{editor ? null : <MergePolicyTerms policy={policy} verify={verify} />}
						<dt>Signed records</dt>
						<dd>
							{snapshot.verified
								? "Records and merges are stamped with verified identity"
								: "Records are not stamped: names are as agents give them"}
						</dd>
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
						<dd>
							Each change works in its own fork: agents can't write {snapshot.branch ?? "main"}; only the toolkit
							merges, once the conventions hold.
						</dd>
						{snapshot.github ? (
							<>
								<dt>GitHub</dt>
								<dd>{githubTerms(snapshot.github, snapshot.branch ?? "main")}</dd>
							</>
						) : null}
					</dl>
				</div>
			</section>
			{access}
		</div>
	);
}
