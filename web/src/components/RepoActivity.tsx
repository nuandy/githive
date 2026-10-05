import type { HistoryEntry, Task } from "../api";
import { humanizeText } from "../lib/humanize";
import { changesOf, shortSha } from "../lib/model";
import { dayLabel, timeAgo } from "../lib/relativeTime";
import { href, type RepoBase } from "../lib/routes";
import { buildTimeline, classifyHistory, type TimelineItem } from "../lib/timeline";
import { Icon } from "./Icon";
import { kindIcon, linkIds } from "./Timeline";
import "./RepoActivity.css";

export interface ActivityEntry {
	key: string;
	at?: string;
	text: string;
	commit?: string;
	icon: ReturnType<typeof kindIcon>;
	tone: TimelineItem["tone"];
}

/** The repo's decision log, newest first, worded for people. */
export function activityFromHistory(entries: HistoryEntry[], ids: string[]): ActivityEntry[] {
	return entries
		.map((entry, index) => {
			const { kind, tone } = classifyHistory(entry.text);
			const text = humanizeText(entry.text, ids).split("\n")[0];
			return { key: `h:${index}`, at: entry.at || undefined, text, commit: entry.commit || undefined, icon: kindIcon(kind, tone), tone };
		})
		.reverse();
}

/** Without a log (an older server), what the change records show, newest first. */
export function activityFromRecords(task: Task): ActivityEntry[] {
	const changes = changesOf(task);
	const ids = changes.map((change) => change.id);
	const items = changes.flatMap((change) =>
		buildTimeline(change, { ids })
			.filter((item) => item.at)
			.map((item) => ({
				key: `${change.id}:${item.key}`,
				at: item.at,
				text: `${change.id}: ${item.review ? `${item.review.reviewer} reviewer ${item.review.verdict === "approve" ? "approved" : "requested changes"}` : item.text}`,
				commit: item.commit,
				icon: kindIcon(item.kind, item.tone),
				tone: item.tone,
			})),
	);
	return items.sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
}

export interface RepoActivityProps {
	task: Task;
	repo: string;
	base: RepoBase;
	/** The decision log; null when the server can't provide it; undefined while loading. */
	history: HistoryEntry[] | null | undefined;
}

export function RepoActivity({ task, repo, base, history }: RepoActivityProps) {
	const ids = changesOf(task).map((change) => change.id);
	const entries = history ? activityFromHistory(history, ids) : history === null ? activityFromRecords(task) : [];
	const groups: { label: string; entries: ActivityEntry[] }[] = [];
	for (const entry of entries) {
		const label = dayLabel(entry.at);
		const group = groups[groups.length - 1];
		if (group?.label === label) group.entries.push(entry);
		else groups.push({ label, entries: [entry] });
	}
	return (
		<section className="repo-activity" aria-labelledby="repo-activity-title">
			<h2 id="repo-activity-title" className="sr-only">
				Activity
			</h2>
			{history === null ? (
				<p className="muted repo-activity__note">This server doesn't keep a full activity log yet, so this shows what each change's record holds.</p>
			) : null}
			{history === undefined ? (
				<p className="muted" role="status">
					Loading activity…
				</p>
			) : entries.length === 0 ? (
				<div className="box empty">
					<Icon name="activity" size={28} className="muted" />
					<h2>No activity yet</h2>
					<p>Changes opened, reviewed, checked and merged in {repo} show up here.</p>
				</div>
			) : (
				groups.map((group) => (
					<div key={group.label} className="repo-activity__group">
						<h3 className="repo-activity__day">{group.label}</h3>
						<ol className="box repo-activity__list">
							{group.entries.map((entry) => (
								<li key={entry.key} className="repo-activity__entry">
									<span className={`repo-activity__icon tone-${entry.tone}`} aria-hidden="true">
										<Icon name={entry.icon} size={14} />
									</span>
									<p className="repo-activity__text">{linkIds(entry.text, ids, (id) => href.change(repo, id, "conversation", base))}</p>
									<span className="repo-activity__meta muted">
										{entry.commit ? <code>{shortSha(entry.commit)}</code> : null}
										{entry.at ? (
											<time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
												{timeAgo(entry.at)}
											</time>
										) : null}
									</span>
								</li>
							))}
						</ol>
					</div>
				))
			)}
		</section>
	);
}
