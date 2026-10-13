import type { InboxGroup } from "../lib/inbox";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { Counter } from "./ui/badge";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Empty } from "./ui/empty";

/** Every change waiting on a person, across repos, with why. */
export function InboxPage({ groups, loaded, error }: { groups: InboxGroup[]; loaded: boolean; error?: string }) {
	return (
		<Page id="main">
			<div className="mb-4">
				<h1 className="text-display tracking-[-0.01em]">Inbox</h1>
				<p className="mt-1 mb-0 text-muted-foreground">
					Changes the agents can't move forward without you, in every repo.
				</p>
			</div>
			<InboxBody groups={groups} loaded={loaded} error={error} />
		</Page>
	);
}

function InboxBody({ groups, loaded, error }: { groups: InboxGroup[]; loaded: boolean; error?: string }) {
	const count = groups.reduce((sum, group) => sum + group.items.length, 0);
	// What's read fades in as it takes the place of "Loading…"; a repo that comes to wait on you later, on its own.
	const read = useChanged(loaded) && "animate-appear";
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
						When a change needs a decision (reviewers disagree, checks keep failing, an agent is stuck), it shows up
						here.
					</p>
				</Empty>
			</Box>
		);
	return groups.map((group) => <InboxRepo key={group.repo} group={group} arrived={arrived(group.repo)} />);
}

function InboxRepo({ group, arrived }: { group: InboxGroup; arrived: boolean }) {
	const items = useArrivals(group.items.map((item) => item.change));
	return (
		<Box className={cn("[&+&]:mt-4", arrived && "animate-appear")} aria-labelledby={`inbox-${group.repo}`}>
			<BoxHeader>
				<h2 id={`inbox-${group.repo}`} className="inline-flex items-center gap-2 text-body wrap-anywhere">
					<Icon name="repo" className="text-muted-foreground" />
					<a href={group.repoHref}>{group.repo}</a>
				</h2>
				<Counter>{group.items.length}</Counter>
			</BoxHeader>
			<ul className="m-0 list-none p-0">
				{group.items.map((item) => (
					<li
						key={item.change}
						className={cn(
							"flex items-start gap-2.5 border-t border-border px-4 py-3 first:border-t-0",
							items(item.change) && "animate-appear",
						)}
					>
						<span className="mt-0.5 inline-flex shrink-0 text-needs">
							<Icon name="alert" />
						</span>
						<div className="min-w-0">
							<a
								href={item.href}
								className="font-semibold wrap-anywhere text-foreground transition-colors duration-fast hover:text-link"
							>
								{item.title}
							</a>
							<span className="ml-2 font-mono text-caption text-muted-foreground">{item.change}</span>
							<p className="mt-0.75 mb-0 text-ui wrap-anywhere text-muted-foreground">{item.reason}</p>
						</div>
					</li>
				))}
			</ul>
		</Box>
	);
}
