import type { Task } from "../api";
import { agentLabel } from "../lib/agent";
import { checksSummary, deriveChangeStatus, reviewSummary } from "../lib/changeStatus";
import { conflictsByChange, describeConflict } from "../lib/conflicts";
import { changesOf, changeState, timeOf, type Change, type ChangeState } from "../lib/model";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href, type RepoBase } from "../lib/routes";
import { ChecksBadge, ReviewBadge } from "./Badges";
import { Icon } from "./Icon";
import { StatusIcon, StatusPill } from "./StatusPill";
import "./ChangeList.css";

/** Statuses worth a pill next to the title; the rest read fine from the icon and badges. */
const PILLED = new Set(["needs-you", "checks-failed", "waiting", "ready", "approved", "draft", "opening"]);

/** Open changes needing a person first, then newest; ended ones by when they ended. */
export function sortChanges(changes: Change[], state: ChangeState): Change[] {
	const indexed = changes.map((change, index) => ({ change, index }));
	const when = (change: Change) => timeOf(state === "open" ? change.openedAt : change.endedAt ?? change.openedAt);
	return indexed
		.sort((a, b) => {
			if (state === "open") {
				const needs = Number(b.change.attention != null) - Number(a.change.attention != null);
				if (needs) return needs;
			}
			const at = (when(b.change) ?? -Infinity) - (when(a.change) ?? -Infinity);
			return Number.isNaN(at) || at === 0 ? b.index - a.index : at;
		})
		.map(({ change }) => change);
}

export function changeCounts(changes: Change[]): Record<ChangeState, number> {
	const counts: Record<ChangeState, number> = { open: 0, merged: 0, abandoned: 0 };
	for (const change of changes) counts[changeState(change)]++;
	return counts;
}

export interface ChangeListProps {
	task: Task;
	repo: string;
	base: RepoBase;
	state: ChangeState;
}

export function ChangeList({ task, repo, base, state }: ChangeListProps) {
	const all = changesOf(task);
	const counts = changeCounts(all);
	const shown = sortChanges(all.filter((change) => changeState(change) === state), state);
	const conflicts = conflictsByChange(task);
	const filters: { id: ChangeState; label: string; icon: "pull" | "merge" | "ban" }[] = [
		{ id: "open", label: "Open", icon: "pull" },
		{ id: "merged", label: "Merged", icon: "merge" },
		{ id: "abandoned", label: "Abandoned", icon: "ban" },
	];

	return (
		<section className="box change-list" aria-labelledby="change-list-title">
			<h2 id="change-list-title" className="sr-only">
				Changes
			</h2>
			<div className="box__header change-list__filters">
				{filters.map((filter) => (
					<a key={filter.id} href={href.repo(repo, "changes", base, filter.id)} className="change-list__filter" aria-current={filter.id === state ? "page" : undefined}>
						<Icon name={filter.icon} />
						<span className="change-list__count">{counts[filter.id]}</span> {filter.label}
					</a>
				))}
			</div>
			{shown.length === 0 ? (
				<div className="empty">
					<Icon name={state === "open" ? "pull" : state === "merged" ? "merge" : "ban"} size={28} className="muted" />
					<h2>{state === "open" ? "No open changes" : state === "merged" ? "Nothing merged yet" : "No abandoned changes"}</h2>
					{state === "open" ? (
						<p>
							When an agent claims part of <strong>{repo}</strong> and starts work, its change appears here. Agents join with the MCP <code>join_repo</code> tool.
						</p>
					) : null}
				</div>
			) : (
				<ul className="change-list__rows">
					{shown.map((change) => {
						const status = deriveChangeStatus(change, task.review, task.branch);
						const review = reviewSummary(change, task.review);
						const checks = checksSummary(change, task.verify, task.branch);
						const ended = state !== "open";
						const age = ended ? change.endedAt : change.openedAt;
						const own = conflicts.get(change.id) ?? [];
						return (
							<li key={change.id} className="change-row">
								<StatusIcon status={status} />
								<div className="change-row__main">
									<div className="change-row__title">
										<a href={href.change(repo, change.id, "conversation", base)}>{change.title || change.id}</a>
										{PILLED.has(status.kind) ? <StatusPill status={status} /> : null}
									</div>
									<p className="change-row__meta">
										<span className="change-row__id">{change.id}</span>
										<span>
											{" · "}
											{ended ? (status.kind === "merged" ? "merged" : "abandoned") : "opened"}
											{age ? ` ${timeAgo(age)}` : ""} by {agentLabel(change)}
										</span>
										{change.owns.length ? (
											<span className="change-row__paths">
												{" · "}
												<Icon name="folder" size={12} />
												{change.owns.join(", ")}
											</span>
										) : null}
									</p>
									{own.map((conflict) => (
										<p key={conflict.with} className="change-row__warn">
											<Icon name="conflict" size={13} />
											{describeConflict(conflict)}
										</p>
									))}
								</div>
								<div className="change-row__aside">
									{!ended ? <ReviewBadge summary={review} /> : null}
									{!ended ? <ChecksBadge summary={checks} compact /> : null}
									{age ? (
										<time className="change-row__age muted" dateTime={age} title={new Date(age).toLocaleString()}>
											{shortAge(age)}
										</time>
									) : null}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
