import { type InboxGroup, type InboxItem, isUrgent } from "../lib/inbox";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { Badge, Counter } from "./ui/badge";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Empty } from "./ui/empty";

/** Everything waiting on a person, across repos, with why: questions, votes only a person gives, the audit. */
export function InboxPage({ groups, loaded, error }: { groups: InboxGroup[]; loaded: boolean; error?: string }) {
	return (
		<Page>
			<div className="mb-4">
				<h1 className="text-display tracking-[-0.01em]">Inbox</h1>
				<p className="mt-1 mb-0 text-muted-foreground">
					What the agents can't move forward without you, in every repo.
				</p>
			</div>
			<InboxBody groups={groups} loaded={loaded} error={error} />
		</Page>
	);
}

function InboxBody({ groups, loaded, error }: { groups: InboxGroup[]; loaded: boolean; error?: string }) {
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
					<Icon name="check-circle" size={32} className="text-good" />
					<h2>Nothing waits on you</h2>
					<p>
						When an agent asks a person, a change waits on a vote only a person can give, or the audit flags a merge, it
						shows up here.
					</p>
				</Empty>
			</Box>
		);
	return groups.map((group) => <InboxRepo key={group.repo} group={group} arrived={arrived(group.repo)} />);
}

function InboxRepo({ group, arrived }: { group: InboxGroup; arrived: boolean }) {
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
					<li
						key={item.key}
						className={cn(
							"flex items-start gap-2.5 border-t border-border px-4 py-3 first:border-t-0",
							items(item.key) && "animate-appear",
						)}
					>
						<span className="mt-0.5 inline-flex shrink-0 text-needs">
							<Icon name={item.kind === "audit" ? "shield" : "alert"} />
						</span>
						<div className="min-w-0">
							<InboxLine item={item} />
							<p className="mt-0.75 mb-0 text-ui wrap-anywhere text-muted-foreground">{item.reason}</p>
						</div>
					</li>
				))}
			</ul>
		</Box>
	);
}

/** An item's line: what it's about, linked, and what it waits on. */
function InboxLine({ item }: { item: InboxItem }) {
	return (
		<>
			<a
				href={item.href}
				className="font-semibold wrap-anywhere text-foreground transition-colors duration-fast hover:text-link"
			>
				{item.title}
			</a>
			{item.kind === "vote" ? ` waits on a ${item.role} vote` : null}
			{item.change ? <span className="ml-2 font-mono text-caption text-muted-foreground">{item.change}</span> : null}
			{isUrgent(item) ? (
				<Badge tone="bad" className="ml-2 align-[1px]">
					Urgent
				</Badge>
			) : null}
		</>
	);
}
