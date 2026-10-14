import { useEffect, useRef } from "react";
import { useAnnouncer } from "../hooks/useAnnouncer";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { type InboxGroup, type InboxItem, inboxArrivals, isUrgent, itemAction, itemWho } from "../lib/inbox";
import { counted } from "../lib/plural";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Page, PageHeader } from "./Page";
import { Announcer } from "./ui/announcer";
import { Badge, Counter } from "./ui/badge";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";

/** Everything waiting on a person, across repos, with why: questions, votes only a person gives, the audit. */
export function InboxPage({
	groups,
	loaded,
	error,
	now,
}: {
	groups: InboxGroup[];
	loaded: boolean;
	error?: string;
	/** The time ages are told against (tests fix it). */
	now?: number;
}) {
	const said = useArrivalsSaid(groups, loaded);
	return (
		<Page>
			<PageHeader title="Inbox" description="Changes waiting on you, in every repo." />
			<InboxBody groups={groups} loaded={loaded} error={error} now={now} />
			<Announcer said={said} />
		</Page>
	);
}

/** What came into the Inbox while it was open, said to a screen reader (no more often than useAnnouncer lets it). */
function useArrivalsSaid(groups: InboxGroup[], loaded: boolean): string {
	const { said, say } = useAnnouncer();
	const seen = useRef<Set<string> | undefined>(undefined);
	useEffect(() => {
		if (!loaded) return;
		const { fresh, seen: now } = inboxArrivals(seen.current, groups);
		seen.current = now;
		if (fresh.length === 1) {
			const { repo, item } = fresh[0]!;
			say(`New in your Inbox, in ${repo}: ${itemWho(item)}, ${item.kind === "question" ? item.reason : item.title}`);
		} else if (fresh.length > 1) {
			say(`${counted(fresh.length, "new item")} in your Inbox`);
		}
	}, [groups, loaded, say]);
	return said;
}

function InboxBody({
	groups,
	loaded,
	error,
	now,
}: {
	groups: InboxGroup[];
	loaded: boolean;
	error?: string;
	now?: number;
}) {
	const count = groups.reduce((sum, group) => sum + group.count, 0);
	// What's read fades in as it takes the place of "Loading…"; a repo that comes to wait on you later, on its own.
	const read = useChanged(loaded) && "animate-fade";
	const arrived = useArrivals(groups.map((group) => group.repo));
	if (!loaded)
		return (
			<p className="my-3.75 text-muted-foreground" role="status">
				Loading…
			</p>
		);
	if (error && !groups.length)
		return (
			<Callout tone="bad" className={cn(read)} role="alert">
				<Icon name="x" className="text-bad" />
				<div>
					<strong>Couldn't load the inbox</strong>
					<p>{error}</p>
				</div>
			</Callout>
		);
	if (count === 0)
		return (
			<Box asChild>
				<Empty className={cn(read)}>
					<Icon name="check-circle" size={28} className="text-good" />
					<h2>Nothing waits on you</h2>
					<p>
						When an agent asks a person, a change waits on a vote only a person can give, or the audit flags a merge, it
						shows up here.
					</p>
				</Empty>
			</Box>
		);
	return groups.map((group) => <InboxRepo key={group.repo} group={group} arrived={arrived(group.repo)} now={now} />);
}

function InboxRepo({ group, arrived, now }: { group: InboxGroup; arrived: boolean; now?: number | undefined }) {
	const items = useArrivals(group.items.map((item) => item.key));
	const staggers = useStagger(group.items.length > 0);
	return (
		<Box className={cn("[&+&]:mt-4", arrived && "animate-appear")} aria-labelledby={`inbox-${group.repo}`}>
			<BoxHeader>
				<h2 id={`inbox-${group.repo}`} className="inline-flex items-center gap-2 text-body wrap-anywhere">
					<Icon name="repo" className="text-muted-foreground" />
					<a href={group.repoHref}>{group.repo}</a>
				</h2>
				<Counter>{group.count}</Counter>
			</BoxHeader>
			<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
				{group.items.map((item) => (
					<InboxRow key={item.key} item={item} arrived={items(item.key)} now={now} />
				))}
			</ul>
		</Box>
	);
}

/** Each kind's mark, and what it says to a screen reader. */
const KIND: Record<InboxItem["kind"], { icon: IconName; label: string }> = {
	question: { icon: "question", label: "A question" },
	vote: { icon: "check-circle", label: "A vote" },
	audit: { icon: "shield", label: "The audit" },
};

/**
 * An item: its kind's mark; who waits and for how long ("mara/claude asks · 38m"); the question, or what to vote on,
 * at body size in ink; the change it's about; and what to do, on a button: answer, vote, or read the audit.
 */
function InboxRow({ item, arrived, now }: { item: InboxItem; arrived: boolean; now?: number | undefined }) {
	const action = itemAction(item);
	const body = item.kind === "question" ? item.reason : item.title;
	const urgent = isUrgent(item);
	return (
		<li
			className={cn(
				"flex items-start gap-3 border-t border-border px-4 py-3.5 first:border-t-0",
				arrived && "animate-appear",
			)}
		>
			<span className="mt-0.5 inline-flex shrink-0 text-needs">
				<Icon name={KIND[item.kind].icon} label={KIND[item.kind].label} />
			</span>
			<div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-2.5">
				<div className="grid min-w-0 flex-[1_1_20rem] gap-1">
					<p className="m-0 flex flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground">
						<span className="wrap-anywhere">{itemWho(item)}</span>
						{item.at ? (
							<>
								<span aria-hidden="true">·</span>
								<time dateTime={item.at}>
									<span aria-hidden="true">{shortAge(item.at, now)}</span>
									<span className="sr-only">{timeAgo(item.at, now)}</span>
								</time>
							</>
						) : null}
						{urgent ? (
							<Badge tone="bad" size="sm" className="ml-1">
								Urgent
							</Badge>
						) : null}
					</p>
					<p className="m-0 max-w-measure text-body wrap-anywhere text-foreground">{body}</p>
					{item.kind === "question" ? (
						<p className="m-0 flex flex-wrap items-baseline gap-x-2 text-meta text-muted-foreground">
							<a href={item.href} className="wrap-anywhere">
								{item.title}
							</a>
							{item.change && item.change !== item.title ? (
								<span className="font-mono text-caption">{item.change}</span>
							) : null}
						</p>
					) : null}
					{item.kind === "vote" ? (
						<p className="m-0 flex flex-wrap items-baseline gap-x-2 text-meta text-muted-foreground">
							<span>{item.reason}</span>
							{item.change ? (
								<a href={item.href} className="font-mono text-caption">
									{item.change}
								</a>
							) : null}
						</p>
					) : null}
					{item.kind === "audit" ? <p className="m-0 text-meta text-muted-foreground">{item.reason}</p> : null}
				</div>
				<Button asChild size="sm" className="ml-auto shrink-0 to-560:ml-0">
					<a href={action.href}>{action.label}</a>
				</Button>
			</div>
		</li>
	);
}
