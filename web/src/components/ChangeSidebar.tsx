import { identityName } from "../lib/agent";
import type { ReactNode } from "react";
import type { AgentState, Live, Task } from "../api";
import { agentLabel, isHosted } from "../lib/agent";
import { reviewSummary, changePolicy } from "../lib/changeStatus";
import { humanizeText } from "../lib/humanize";
import { changesOf, isActive, type Change } from "../lib/model";
import { timeAgo, timeUntil } from "../lib/relativeTime";
import { href, type RepoBase } from "../lib/routes";
import { Icon, type IconName } from "./Icon";
import { TonePill } from "./StatusPill";
import "./ChangeSidebar.css";

type LiveAgent = Live["agents"][number];
type Request = NonNullable<Task["laneChangeRequests"]>[number];

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="sidebar-section">
			<h2>{title}</h2>
			{children}
		</section>
	);
}

const BUILDER_WORDS: Record<AgentState["status"], { label: string; tone: "good" | "bad" | "warn" | "neutral" | "accent"; icon: IconName }> = {
	queued: { label: "Waiting for a slot", tone: "neutral", icon: "clock" },
	working: { label: "Working", tone: "warn", icon: "loader" },
	parked: { label: "Paused, waiting on other changes", tone: "accent", icon: "pause" },
	done: { label: "Done", tone: "good", icon: "check" },
	failed: { label: "Failed", tone: "bad", icon: "x" },
};

/** The builder's latest event a person would care about. */
export function lastBuilderEvent(state: AgentState | null | undefined) {
	const log = Array.isArray(state?.log) ? state.log : [];
	for (let i = log.length - 1; i >= 0; i--) {
		const entry = log[i];
		if (entry && typeof entry.event === "string" && !/^(run:|nudged:)/.test(entry.event)) return entry;
	}
	return undefined;
}

const REQUEST_TONE: Record<Request["status"], "good" | "bad" | "warn" | "accent" | "needs"> = {
	pending: "warn",
	answered: "accent",
	declined: "bad",
	integrated: "good",
	human: "needs",
};
const REQUEST_WORDS: Record<Request["status"], string> = { pending: "Pending", answered: "Answered", declined: "Declined", integrated: "Merged", human: "Needs you" };

/** Requests between this change and others to edit inside each other's claims. */
export function ClaimRequests({ requests, changeId, link }: { requests: Request[]; changeId: string; link: (id: string) => string }) {
	return (
		<ul className="sidebar-requests">
			{requests.map((request) => {
				const outgoing = request.requester === changeId;
				const other = outgoing ? request.owner : request.requester;
				return (
					<li key={request.id}>
						<div className="sidebar-requests__head">
							<span>
								{outgoing ? "Asked " : "Asked by "}
								<a href={link(other)}>{other}</a>
							</span>
							<TonePill tone={REQUEST_TONE[request.status]}>{REQUEST_WORDS[request.status]}</TonePill>
						</div>
						<code>{request.path}</code>
						<p>{request.need}</p>
						{request.reason ? <p className="muted">Why: {request.reason}</p> : null}
						{request.answer ? <p className="muted">Answer: {request.answer}</p> : null}
					</li>
				);
			})}
		</ul>
	);
}

export interface ChangeSidebarProps {
	task: Task;
	change: Change;
	agent?: LiveAgent;
	repo: string;
	base: RepoBase;
}

export function ChangeSidebar({ task, change, agent, repo, base }: ChangeSidebarProps) {
	const review = reviewSummary(change, changePolicy(change, task));
	const liveReviewers = new Map((agent?.reviewers ?? []).map((r) => [r.role, r.state]));
	const builder = agent?.builder;
	const hosted = isHosted(change);
	const requests = (task.laneChangeRequests ?? []).filter((r) => r.requester === change.id || r.owner === change.id);
	const parkedOn = builder?.status === "parked" ? (task.laneChangeRequests ?? []).filter((r) => builder.waitingRequestIds?.includes(r.id) || (r.requester === change.id && (r.status === "pending" || r.status === "answered"))) : [];
	const last = lastBuilderEvent(builder);
	const ids = changesOf(task).map((c) => c.id);
	const link = (id: string) => href.change(repo, id, "conversation", base);
	const words = builder ? BUILDER_WORDS[builder.status] : undefined;

	return (
		<aside className="change-sidebar" aria-label="Change details">
			<Section title="Reviewers">
				{review.reviewers.length ? (
					<ul className="sidebar-reviewers">
						{review.reviewers.map((reviewer) => {
							const live = liveReviewers.get(reviewer.role);
							const waiting = reviewer.external ? "waiting for a reviewer" : "pending";
							const state = reviewer.verdict === "approve" ? "approved" : reviewer.verdict === "reject" ? "requested changes" : live?.status === "working" ? "reviewing" : live?.status === "queued" ? "queued" : change.reviewHead ? waiting : "";
							const who = identityName(reviewer.review?.by);
							const icon: IconName = reviewer.verdict === "approve" ? "check" : reviewer.verdict === "reject" ? "x" : live?.status === "working" ? "loader" : "dot";
							const tone = reviewer.verdict === "approve" ? "good" : reviewer.verdict === "reject" ? "bad" : live?.status === "working" ? "warn" : "neutral";
							return (
								<li key={reviewer.role}>
									<span className="sidebar-reviewers__role">
										<Icon name="shield" size={14} className="muted" />
										{reviewer.role}
										{reviewer.veto ? (
											<span className="muted sidebar-reviewers__veto" title="A rejection from this reviewer blocks the change">
												can block
											</span>
										) : null}
										{reviewer.external ? (
											<span className="muted sidebar-reviewers__veto" title="An outside agent reviews this role, through review_queue and submit_review">
												{who ? `by ${who}` : "outside agent"}
											</span>
										) : null}
									</span>
									{state ? (
										<span className={`sidebar-reviewers__state tone-${tone}`} title={state}>
											<Icon name={icon} size={14} />
											<span>{state}</span>
										</span>
									) : null}
								</li>
							);
						})}
					</ul>
				) : (
					<p className="muted">No review required: it merges once the checks pass.</p>
				)}
				<p className="muted sidebar-note">
					{review.required} {review.required === 1 ? "approval" : "approvals"} required
					{!change.reviewHead && isActive(change) ? "; reviews start when the agent submits its work" : ""}
				</p>
			</Section>

			<Section title="Agent">
				<p className="sidebar-agent">
					<Icon name={hosted ? "bot" : "user"} size={14} className="muted" />
					<strong>{agentLabel(change)}</strong>
				</p>
				{hosted ? (
					words ? (
						<>
							<p className={`sidebar-agent__status tone-${words.tone}`}>
								<Icon name={words.icon} size={14} />
								{words.label}
								{builder?.status === "parked" && builder.parkedAt ? <span className="muted"> since {timeAgo(builder.parkedAt)}</span> : null}
							</p>
							{builder?.error && builder.status === "failed" ? <p className="tone-bad sidebar-small">{humanizeText(builder.error, ids, task.branch)}</p> : null}
							{parkedOn.length ? (
								<p className="sidebar-small">
									Waiting on{" "}
									{parkedOn.map((r, i) => (
										<span key={r.id}>
											{i ? ", " : ""}
											<a href={link(r.owner)}>{r.owner}</a> (<code>{r.path}</code>)
										</span>
									))}
								</p>
							) : null}
							{last ? (
								<p className="muted sidebar-small">
									Last: {humanizeText(last.event, ids, task.branch)}
									{last.at ? ` · ${timeAgo(last.at)}` : ""}
								</p>
							) : null}
						</>
					) : (
						<p className="muted sidebar-small">{isActive(change) ? "Blueprint's hosted builder; not started yet." : "Blueprint's hosted builder."}</p>
					)
				) : (
					<p className="muted sidebar-small">
						An outside agent connected over MCP.
						{change.inbox?.length ? ` ${change.inbox.length} ${change.inbox.length === 1 ? "message" : "messages"} sent to it.` : ""}
					</p>
				)}
				{change.revisions ? (
					<p className="muted sidebar-small">
						Sent back {change.revisions} {change.revisions === 1 ? "time" : "times"}
					</p>
				) : null}
			</Section>

			<Section title="Claim">
				{change.owns.length ? (
					<ul className="sidebar-paths">
						{change.owns.map((path) => (
							<li key={path}>
								<Icon name="folder" size={13} className="muted" />
								<code>{path}</code>
							</li>
						))}
					</ul>
				) : (
					<p className="muted">No paths claimed.</p>
				)}
				{isActive(change) && change.leaseUntil ? <p className="muted sidebar-note">Claim expires {timeUntil(change.leaseUntil)} without activity</p> : null}
				{!isActive(change) ? <p className="muted sidebar-note">Released</p> : null}
			</Section>

			{requests.length ? (
				<Section title="Requests to other claims">
					<ClaimRequests requests={requests} changeId={change.id} link={link} />
				</Section>
			) : null}
		</aside>
	);
}
