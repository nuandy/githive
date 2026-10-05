import { useEffect, useState } from "react";
import type { HistoryEntry, Live, Task } from "../api";
import { agentLabel, isHosted } from "../lib/agent";
import { checksSummary, currentGate, deriveChangeStatus } from "../lib/changeStatus";
import { conflictsFor, describeConflict } from "../lib/conflicts";
import { changesOf, shortSha, type Change } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { href, type ChangeTab, type RepoBase } from "../lib/routes";
import { buildTimeline } from "../lib/timeline";
import { ChangeActions, type ChangeActionsApi } from "./ChangeActions";
import { ChangeSidebar } from "./ChangeSidebar";
import { CheckResults } from "./CheckResults";
import { FilesChanged, type DiffState } from "./FilesChanged";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";
import { Tabs } from "./Tabs";
import { Timeline } from "./Timeline";
import "./ChangePage.css";

export interface ChangePageProps {
	task: Task;
	change: Change;
	/** Live agents on this change (hosted builder, reviewers), when loaded. */
	agent?: Live["agents"][number];
	/** The repo's decision log: null when the server can't provide it, undefined while loading. */
	history?: HistoryEntry[] | null;
	repo: string;
	base: RepoBase;
	tab: ChangeTab;
	api: ChangeActionsApi;
	/** Refresh after an action. */
	onChanged(): void;
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The change's diff: the commit under review, or before review its latest push. */
function useReviewDiff(task: Task, change: Change, api: ChangeActionsApi) {
	const head = change.reviewHead ?? change.head;
	const key = head ? JSON.stringify([task.id, change.id, head, change.mergeBase]) : null;
	const [state, setState] = useState<{ key: string; value: DiffState } | null>(null);
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		if (!key) return;
		let active = true;
		setState({ key, value: { loading: true } });
		api.sliceDiff(task.id, change.id).then(
			(diff) => active && setState({ key, value: { loading: false, diff } }),
			(error: unknown) => active && setState({ key, value: { loading: false, error: message(error) } }),
		);
		return () => {
			active = false;
		};
	}, [key, retry]);
	const value = key ? (state?.key === key ? state.value : { loading: true }) : undefined;
	return { diff: value, retry: () => setRetry((n) => n + 1) };
}

export function ChangeHeader({ task, change }: { task: Task; change: Change }) {
	const status = deriveChangeStatus(change, task.review, task.branch);
	const agent = agentLabel(change);
	const branch = <code className="change-header__branch">changes/{change.id}</code>;
	const main = <code className="change-header__branch">{task.branch ?? "main"}</code>;
	return (
		<div className="change-header">
			<h1 className="change-header__title">
				{change.title || change.id} <span className="change-header__id">{change.id}</span>
			</h1>
			<div className="change-header__meta">
				<StatusPill status={status} size="lg" solid />
				<span>
					{status.kind === "merged" ? (
						<>
							<strong>{agent}</strong> merged {branch} into {main}
							{change.endedAt ? ` ${timeAgo(change.endedAt)}` : ""}
						</>
					) : status.kind === "abandoned" ? (
						<>
							<strong>{agent}</strong>’s change {branch} was abandoned{change.endedAt ? ` ${timeAgo(change.endedAt)}` : ""}
						</>
					) : (
						<>
							<strong>{agent}</strong> wants to merge {branch} into {main}
							{change.openedAt ? <span className="muted"> · opened {timeAgo(change.openedAt)}</span> : null}
						</>
					)}
				</span>
			</div>
		</div>
	);
}

function Description({ change }: { change: Change }) {
	const text = change.intent || change.instructions;
	return (
		<article className={`comment${isHosted(change) ? "" : " comment--outside"}`}>
			<div className="comment__header">
				<strong>{agentLabel(change)}</strong>{" "}
				<span className="muted">
					opened this change{change.openedAt ? ` ${timeAgo(change.openedAt)}` : ""}
					{change.owns.length ? ` · claims ${change.owns.join(", ")}` : ""}
				</span>
			</div>
			<div className="comment__body">{text ? text : <span className="muted">No description provided.</span>}</div>
			{change.buildSummary ? (
				<div className="comment__section">
					<h3>What the builder says it did</h3>
					<div className="comment__body comment__body--flush">{change.buildSummary}</div>
				</div>
			) : null}
		</article>
	);
}

function ChecksTab({ task, change }: { task: Task; change: Change }) {
	const gate = currentGate(change) ?? change.gate;
	const summary = checksSummary(change, task.verify, task.branch);
	if (!task.verify.length && !gate)
		return (
			<div className="box empty">
				<Icon name="check-circle" size={28} className="muted" />
				<h2>No merge checks</h2>
				<p>This repo merges a change as soon as it is approved. Checks are commands like a test suite that must pass first.</p>
			</div>
		);
	return (
		<section className="box checks-tab" aria-labelledby="checks-title">
			<div className="box__header">
				<h2 id="checks-title" className={`checks-tab__title tone-${summary.tone}`}>
					{summary.state === "not-run" ? "Checks run once the change is approved" : summary.label}
				</h2>
				{gate ? (
					<span className="muted">
						on <code>{shortSha(gate.head)}</code> merged with {task.branch ?? "main"}{gate.at ? ` · ${timeAgo(gate.at)}` : ""}
					</span>
				) : null}
			</div>
			<CheckResults gate={gate} verify={task.verify} branch={task.branch} />
			{gate?.group?.length ? <p className="box__row muted">Checked together with {gate.group.join(", ")}, which depend on each other.</p> : null}
			{gate?.excluded?.length ? (
				<div className="box__row">
					<p className="muted">Left out until the changes they belong to merge:</p>
					<ul className="checks-tab__excluded">
						{gate.excluded.map((test) => (
							<li key={test}>
								<code>{test}</code>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

export function ChangePage({ task, change, agent, history, repo, base, tab, api, onChanged }: ChangePageProps) {
	const { diff, retry } = useReviewDiff(task, change, api);
	const conflicts = conflictsFor(task, change.id);
	const ids = changesOf(task).map((c) => c.id);
	const timeline = buildTimeline(change, { history: history ?? null, builderLog: agent?.builder?.log, ids, branch: task.branch });
	const files = diff?.diff?.files.length ?? change.touched.length;
	const checkCount = Math.max(task.verify.length, change.gate?.result?.results?.length ?? 0);
	const link = (id: string) => href.change(repo, id, "conversation", base);

	return (
		<div className="change-page">
			<ChangeHeader task={task} change={change} />
			<Tabs
				label="Change sections"
				current={tab}
				items={[
					{ id: "conversation", label: "Conversation", icon: "comment", href: href.change(repo, change.id, "conversation", base) },
					{ id: "files", label: "Files changed", icon: "file", href: href.change(repo, change.id, "files", base), count: files },
					{ id: "checks", label: "Checks", icon: "check-circle", href: href.change(repo, change.id, "checks", base), count: checkCount },
				]}
			/>
			<div className="change-page__body">
				{tab === "conversation" ? (
					<div className="change-layout">
						<div className="change-layout__main">
							{conflicts.map((conflict) => (
								<div key={conflict.with} className="callout callout--warn">
									<Icon name="conflict" className="tone-warn" />
									<div>
										<strong>{describeConflict(conflict)}</strong>
										<p className="muted">One of the two will need to merge the other's work and resolve the conflict before both can merge.</p>
									</div>
								</div>
							))}
							{change.outOfLane?.length ? (
								<div className="callout callout--warn">
									<Icon name="alert" className="tone-warn" />
									<div>
										<strong>Edits outside its claim</strong>
										<p>
											{change.outOfLane.map((path, i) => (
												<span key={path}>
													{i ? ", " : ""}
													<code>{path}</code>
												</span>
											))}
										</p>
									</div>
								</div>
							) : null}
							<Description change={change} />
							{history === undefined ? <p className="muted change-layout__loading">Loading history…</p> : null}
							<Timeline items={timeline.filter((item) => item.kind !== "opened")} ids={ids} link={link} branch={task.branch} />
							<ChangeActions task={task} change={change} conflicts={conflicts} repo={repo} base={base} diffStatus={diff?.diff && diff.diff.head === change.reviewHead ? "loaded" : diff?.error ? "failed" : "loading"} api={api} onChanged={onChanged} />
						</div>
						<ChangeSidebar task={task} change={change} agent={agent} repo={repo} base={base} />
					</div>
				) : tab === "files" ? (
					<FilesChanged change={change} diff={diff} onRetry={retry} />
				) : (
					<ChecksTab task={task} change={change} />
				)}
			</div>
		</div>
	);
}
