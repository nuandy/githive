import { Fragment, type ReactNode } from "react";
import type { Tone } from "../lib/changeStatus";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import type { TimelineItem, TimelineKind } from "../lib/timeline";
import { CheckResults } from "./CheckResults";
import { Icon, type IconName } from "./Icon";
import "./Timeline.css";

export function kindIcon(kind: TimelineKind, tone: Tone): IconName {
	switch (kind) {
		case "opened":
			return "pull";
		case "pushed":
			return "commit";
		case "review-requested":
			return "eye";
		case "review":
		case "review-result":
			return tone === "good" ? "check" : "x";
		case "changes-requested":
			return "x";
		case "needs-you":
			return "alert";
		case "waiver":
			return "shield";
		case "checks":
			return tone === "good" ? "check" : tone === "bad" ? "x" : "clock";
		case "merged":
			return "merge";
		case "abandoned":
			return "ban";
		case "message":
			return "comment";
		case "agent":
			return "bot";
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
		const start = (match.index ?? 0) + match[1].length;
		parts.push(text.slice(last, start));
		parts.push(
			<a key={`${start}:${match[2]}`} href={link(match[2])}>
				{match[2]}
			</a>,
		);
		last = start + match[2].length;
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
				<strong>{review.reviewer}</strong> reviewer {approved ? "approved these changes" : "requested changes"}
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

export function Timeline({ items, ids = [], link, branch }: { items: TimelineItem[]; ids?: string[]; link?: (id: string) => string; branch?: string }) {
	if (!items.length) return null;
	const text = (value: string) => (link ? linkIds(value, ids, link) : value);
	return (
		<ol className="timeline">
			{items.map((item) => (
				<li key={item.key} className={`timeline__item timeline__item--${item.kind}`}>
					<span className={`timeline__badge timeline__badge--${item.tone}`} aria-hidden="true">
						<Icon name={kindIcon(item.kind, item.tone)} size={14} />
					</span>
					<div className="timeline__content">
						{item.review ? (
							<ReviewCard item={item} />
						) : (
							<>
								<p className="timeline__line">
									<span>{text(item.text)}</span>
									{item.commit && !item.text.includes(shortSha(item.commit)) ? (
										<>
											{" "}
											<code className="timeline__sha">{shortSha(item.commit)}</code>
										</>
									) : null}
									{item.at ? (
										<span className="muted">
											{" · "}
											<When at={item.at} />
										</span>
									) : null}
								</p>
								{item.body ? <div className={`timeline__body${item.kind === "pushed" ? " timeline__body--commit" : ""}`}>{text(item.body)}</div> : null}
								{item.gate?.result?.results?.length || item.gate?.result?.mergeConflict?.length ? (
									<CheckResults gate={item.gate} compact branch={branch} />
								) : null}
							</>
						)}
					</div>
				</li>
			))}
		</ol>
	);
}
