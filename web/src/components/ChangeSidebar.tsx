import type { ChangeHistory, RepoSnapshot } from "../api";
import { identityName } from "../lib/agent";
import type { Claim } from "../lib/claimStatus";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";
import { TonePill } from "./StatusPill";
import "./ChangeSidebar.css";

/** The change as recorded: its claim while in force, or the claim from its history. */
export type ChangeRecord = Claim | NonNullable<ChangeHistory["claim"]>;
type Vote = RepoSnapshot["votes"][number];
type HostedReviewer = NonNullable<Claim["hosted"]>["reviewers"][number];

function verdictTone(verdict: HostedReviewer["verdict"]): string {
	if (verdict === "approve") return "good";
	if (verdict === "reject") return "bad";
	return "neutral";
}

const reviewCount = (count: number) => (count ? `${count} ${count === 1 ? "review" : "reviews"}` : "No reviews yet.");

/** The change's details beside the conversation: reviewers, agent, claimed paths, and who blocks it. */
export function ChangeSidebar({
	snapshot,
	claim,
	record,
	agent,
	votes,
}: {
	snapshot: RepoSnapshot;
	claim: Claim | undefined;
	record: ChangeRecord | undefined;
	agent: string;
	votes: Vote[];
}) {
	const builder = claim?.hosted?.builder;
	return (
		<aside className="change-sidebar" aria-label="Change details">
			<section className="sidebar-section">
				<h2>Reviewers</h2>
				{claim?.hosted?.reviewers.length ? (
					<ul className="sidebar-reviewers">
						{claim.hosted.reviewers.map((reviewer) => (
							<li key={reviewer.role}>
								<span className="sidebar-reviewers__role">
									<Icon name="shield" size={14} className="muted" />
									{reviewer.role}
								</span>
								<span className={`sidebar-reviewers__state tone-${verdictTone(reviewer.verdict)}`}>
									{reviewer.verdict ?? reviewer.status}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="muted">{reviewCount(votes.length)}</p>
				)}
				<p className="muted sidebar-note">{snapshot.policy.required} approvals required</p>
			</section>
			<section className="sidebar-section">
				<h2>Agent</h2>
				<p className="sidebar-agent">
					<Icon name={builder ? "bot" : "user"} size={14} className="muted" />
					<strong>{agent}</strong>
					{record?.by && identityName(record.by) !== agent ? (
						<span className="muted"> · {identityName(record.by)}</span>
					) : null}
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
	);
}
