import { identityName } from "../lib/agent";
import { Fragment, type ReactNode } from "react";
import { useArrivals } from "../hooks/useArrivals";
import { useStagger } from "../hooks/useStagger";
import type { Tone } from "../lib/changeStatus";
import { shortSha } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { roleName } from "../lib/roles";
import type { TimelineItem, TimelineKind } from "../lib/timeline";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";

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

const THIN_NOTE = "Clef found this approval's evidence too thin to show what was checked.";

/** A review, shown as a card like a pull request review. */
function ReviewCard({ item }: { item: TimelineItem }) {
	const review = item.review!;
	const approved = review.verdict === "approve";
	return (
		<div className="-mt-1.5 overflow-hidden rounded-md border border-border bg-card">
			<div
				className={cn("border-b border-border px-3.5 py-2.25 wrap-anywhere", approved ? "bg-good-soft" : "bg-bad-soft")}
			>
				{review.by ? (
					<>
						<strong>{identityName(review.by)}</strong> ({roleName(review.reviewer)}){" "}
						{approved ? "approved these changes" : "requested changes"}
					</>
				) : (
					<>
						<strong>{roleName(review.reviewer)}</strong> {approved ? "approved these changes" : "requested changes"}
					</>
				)}
				{review.head ? (
					<>
						{" on "}
						<code>{shortSha(review.head)}</code>
					</>
				) : null}
				<span className="text-muted-foreground"> · </span>
				<span className="text-muted-foreground">
					<When at={review.at} />
				</span>
			</div>
			{review.summary ? (
				<div className="max-w-measure px-3.5 py-3 whitespace-pre-wrap wrap-anywhere">{review.summary}</div>
			) : null}
			{review.thin ? <p className="m-0 px-3.5 py-3 wrap-anywhere text-muted-foreground">{THIN_NOTE}</p> : null}
			{review.evidence ? (
				<details className="disclosure px-3.5 pb-3">
					<summary className="mb-1.5 cursor-pointer text-ui text-muted-foreground">Evidence</summary>
					<pre tabIndex={0} className="max-h-90">
						{review.evidence}
					</pre>
				</details>
			) : null}
		</div>
	);
}

/** A commit's short sha, linked when the item says where to. */
function CommitSha({ commit, commitHref }: { commit: string; commitHref: string | undefined }) {
	const sha = <code className="text-caption">{shortSha(commit)}</code>;
	return commitHref ? <a href={commitHref}>{sha}</a> : sha;
}

/** Any item but a review: a line saying what happened, and its body. */
function TimelineEvent({ item, withLinks }: { item: TimelineItem; withLinks: (value: string) => ReactNode }) {
	// The line may name the commit already.
	const commit = item.commit && !item.text.includes(shortSha(item.commit)) ? item.commit : undefined;
	return (
		<>
			<p className="m-0 wrap-anywhere">
				<span>{withLinks(item.text)}</span>
				{commit ? (
					<>
						{" "}
						<CommitSha commit={commit} commitHref={item.commitHref} />
					</>
				) : null}
				{item.at ? (
					<span className="text-muted-foreground">
						{" · "}
						<When at={item.at} />
					</span>
				) : null}
			</p>
			{item.body ? (
				<div
					className={cn(
						"prose mt-1.5 text-foreground whitespace-pre-wrap wrap-anywhere",
						// A commit's message in a box of its own, in the code's face; anything else, set off by a rule.
						item.kind === "pushed"
							? "rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-meta"
							: "max-w-measure border-l-3 border-border px-3 py-2 text-ui-lg",
					)}
				>
					{withLinks(item.body)}
				</div>
			) : null}
		</>
	);
}

/** The timeline's column: its entries on a rule that runs down through their badges. */
export function TimelineList({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<ol
			className={cn(
				"relative m-0 list-none px-0 py-1",
				"before:absolute before:inset-y-0 before:left-3.75 before:w-0.5 before:bg-border before:content-['']",
				className,
			)}
		>
			{children}
		</ol>
	);
}

/** A badge's colors by tone; neutral, or none, is the rule's own grey. */
const BADGE: Partial<Record<Tone, string>> = {
	good: "bg-good text-good-foreground",
	bad: "bg-bad text-bad-foreground",
	warn: "bg-warn-soft text-warn",
	needs: "bg-needs text-needs-foreground",
	accent: "bg-link-soft text-link",
};

/** Pushes and notes sit on the page's own paper, whatever their tone; a merge is always green. */
const KIND_BADGE: Partial<Record<TimelineKind, string>> = {
	pushed: "bg-background text-muted-foreground",
	note: "bg-background text-muted-foreground",
	merged: "bg-good text-good-foreground",
};

/** One entry: its badge on the rule, and what happened beside it. */
export function TimelineEntry({
	icon,
	tone,
	kind,
	className,
	children,
}: {
	icon: IconName;
	tone?: Tone;
	kind?: TimelineKind;
	className?: string;
	children: ReactNode;
}) {
	return (
		<li className={cn("relative flex min-w-0 gap-3 py-2", kind === "review" && "py-2.5", className)}>
			<span
				className={cn(
					"relative z-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-background",
					"bg-surface-3 text-muted-foreground transition-colors duration-base",
					tone && BADGE[tone],
					kind && KIND_BADGE[kind],
				)}
				aria-hidden="true"
			>
				<Icon name={icon} size={14} />
			</span>
			<div className="min-w-0 flex-1 pt-1.5">{children}</div>
		</li>
	);
}

export function Timeline({
	items,
	ids = [],
	link,
	className,
}: {
	items: TimelineItem[];
	ids?: string[];
	link?: (id: string) => string;
	className?: string;
}) {
	// What happens after the timeline first showed fades in as it joins.
	const arrived = useArrivals(items.map((item) => item.key));
	const staggers = useStagger(items.length > 0);
	if (!items.length) return null;
	const withLinks = (value: string) => (link ? linkIds(value, ids, link) : value);
	return (
		<TimelineList className={cn(className, staggers && "stagger")}>
			{items.map((item) => (
				<TimelineEntry
					key={item.key}
					icon={kindIcon(item.kind, item.tone)}
					tone={item.tone}
					kind={item.kind}
					className={cn(arrived(item.key) && "animate-appear")}
				>
					{item.review ? <ReviewCard item={item} /> : <TimelineEvent item={item} withLinks={withLinks} />}
				</TimelineEntry>
			))}
		</TimelineList>
	);
}
