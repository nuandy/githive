import { identityName } from "../lib/agent";
import { Fragment, type ReactNode } from "react";
import type { Tone } from "../lib/changeStatus";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import type { TimelineItem, TimelineKind } from "../lib/timeline";
import { Icon, type IconName } from "./Icon";
import "./Timeline.css";

export function kindIcon(kind: TimelineKind, tone: Tone): IconName {
	switch (kind) {
		case "opened":
			return "pull";
		case "pushed":
			return "commit";
		case "review":
			return tone === "good" ? "check" : "x";
		case "changes-requested":
			return "x";
		case "needs-you":
			return "alert";
		case "merged":
			return "merge";
		case "abandoned":
			return "ban";
		case "attempt":
			return "alert";
		default:
			return "dot";
	}
}

/** Text with change ids turned into links. */
export function linkIds(text: string, ids: string[], link: (id: string) => string): ReactNode {
	const sorted = [...new Set(ids.filter(Boolean))].sort((a, b) => b.length - a.length);
	if (!sorted.length) return text;
	const escaped = sorted.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const [, before = "", id] = match;
		if (!id) continue;
		const start = (match.index ?? 0) + before.length;
		parts.push(text.slice(last, start));
		parts.push(
			<a key={`${start}:${id}`} href={link(id)}>
				{id}
			</a>,
		);
		last = start + id.length;
	}
	parts.push(text.slice(last));
	return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

function When({ at }: { at?: string }) {
	if (!at) return null;
	return (
		<time dateTime={at} title={new Date(at).toLocaleString()}>
			{timeAgo(at)}
		</time>
	);
}

/** A review, shown as a card like a pull request review. */
function ReviewCard({ item }: { item: TimelineItem }) {
	const review = item.review!;
	const approved = review.verdict === "approve";
	return (
		<div className={`timeline-card timeline-card--${approved ? "good" : "bad"}`}>
			<div className="timeline-card__header">
				{review.by ? (
					<>
						<strong>{identityName(review.by)}</strong> ({review.reviewer} reviewer){" "}
						{approved ? "approved these changes" : "requested changes"}
					</>
				) : (
					<>
						<strong>{review.reviewer}</strong> reviewer {approved ? "approved these changes" : "requested changes"}
					</>
				)}
				{review.head ? (
					<>
						{" on "}
						<code>{shortSha(review.head)}</code>
					</>
				) : null}
				<span className="muted"> · </span>
				<span className="muted">
					<When at={review.at} />
				</span>
			</div>
			{review.summary ? <div className="timeline-card__body">{review.summary}</div> : null}
			{review.evidence ? (
				<details className="timeline-card__evidence">
					<summary>Evidence</summary>
					<pre tabIndex={0}>{review.evidence}</pre>
				</details>
			) : null}
		</div>
	);
}

/** A commit's short sha, linked when the item says where to. */
function CommitSha({ commit, commitHref }: { commit: string; commitHref: string | undefined }) {
	const sha = <code className="timeline__sha">{shortSha(commit)}</code>;
	return commitHref ? <a href={commitHref}>{sha}</a> : sha;
}

/** Any item but a review: a line saying what happened, and its body. */
function TimelineEvent({ item, withLinks }: { item: TimelineItem; withLinks: (value: string) => ReactNode }) {
	// The line may name the commit already.
	const commit = item.commit && !item.text.includes(shortSha(item.commit)) ? item.commit : undefined;
	return (
		<>
			<p className="timeline__line">
				<span>{withLinks(item.text)}</span>
				{commit ? (
					<>
						{" "}
						<CommitSha commit={commit} commitHref={item.commitHref} />
					</>
				) : null}
				{item.at ? (
					<span className="muted">
						{" · "}
						<When at={item.at} />
					</span>
				) : null}
			</p>
			{item.body ? (
				<div className={`timeline__body${item.kind === "pushed" ? " timeline__body--commit" : ""}`}>
					{withLinks(item.body)}
				</div>
			) : null}
		</>
	);
}

export function Timeline({
	items,
	ids = [],
	link,
}: {
	items: TimelineItem[];
	ids?: string[];
	link?: (id: string) => string;
}) {
	if (!items.length) return null;
	const withLinks = (value: string) => (link ? linkIds(value, ids, link) : value);
	return (
		<ol className="timeline">
			{items.map((item) => (
				<li key={item.key} className={`timeline__item timeline__item--${item.kind}`}>
					<span className={`timeline__badge timeline__badge--${item.tone}`} aria-hidden="true">
						<Icon name={kindIcon(item.kind, item.tone)} size={14} />
					</span>
					<div className="timeline__content">
						{item.review ? <ReviewCard item={item} /> : <TimelineEvent item={item} withLinks={withLinks} />}
					</div>
				</li>
			))}
		</ol>
	);
}
