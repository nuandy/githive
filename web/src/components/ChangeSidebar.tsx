import type { ReactNode } from "react";
import type { ChangeHistory } from "../api";
import type { Claim } from "../lib/claimStatus";
import type { Reader } from "../lib/decision";
import { leaseWords } from "../lib/lease";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** The change as recorded: its claim while in force, or the claim from its history. */
export type ChangeRecord = Claim | NonNullable<ChangeHistory["claim"]>;

/** A part of the sidebar, ruled off from the next. */
function Section({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<section className="min-w-0 border-b border-border py-3.5 first:pt-0 last:border-b-0">
			{title ? <h2 className="mb-2 text-caption font-semibold text-muted-foreground">{title}</h2> : null}
			{children}
		</section>
	);
}

/** A list of paths, a line each. */
const LIST = "m-0 grid list-none gap-1.5 p-0";
/** A small line under a section's own. */
const SMALL = "mt-1 mb-0 text-meta wrap-anywhere";

/**
 * Who the agent works for, when its name doesn't say: a person's agents are named <handle>/<agent>, so only GitHive's
 * own agents (githive-builder, working for whoever asked) need it. The reader is "you"; anyone else a person, since a
 * record keeps only a hash of who they are.
 */
function workingFor(agent: string, by: string | undefined, reader: Reader): string | undefined {
	if (!by || agent.includes("/") || !/^person:[^/]+$/.test(by)) return undefined;
	return by === reader.by ? "for you" : "for a person";
}

/**
 * A claimed path that keeps its file name whole and cuts its folders in the middle when the column is narrow, with the
 * whole path in a tooltip (and for screen readers): "src/compo…/CartDrawer.tsx".
 */
function ClaimedPath({ path }: { path: string }) {
	const folder = path.endsWith("/");
	const parts = path.replace(/\/$/, "").split("/");
	const name = `${parts.pop() ?? ""}${folder ? "/" : ""}`;
	const above = parts.length ? `${parts.join("/")}/` : "";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<code tabIndex={0} className="flex min-w-0 bg-transparent p-0 whitespace-nowrap">
					<span className="sr-only">{path}</span>
					<span aria-hidden="true" className="min-w-0 truncate">
						{above}
					</span>
					<span aria-hidden="true" className="max-w-full shrink-0 truncate">
						{name}
					</span>
				</code>
			</TooltipTrigger>
			<TooltipContent>{path}</TooltipContent>
		</Tooltip>
	);
}

/** The change's details beside the conversation: its agent, and the paths it claims and how long it holds them. */
export function ChangeSidebar({
	claim,
	record,
	agent,
	reader = {},
	now,
	className,
}: {
	claim: Claim | undefined;
	record: ChangeRecord | undefined;
	agent: string;
	reader?: Reader;
	/** The time a lease is told against (tests fix it). */
	now?: number;
	className?: string;
}) {
	const builder = claim?.hosted?.builder;
	const lease = leaseWords(claim?.lease, now);
	const forWhom = workingFor(agent, record?.by, reader);
	return (
		<aside className={cn("grid min-w-0 content-start gap-0", className)} aria-label="Change details">
			<Section title="Agent">
				<p className="m-0 flex items-center gap-1.5 wrap-anywhere">
					<Icon name={builder ? "bot" : "user"} size={14} className="shrink-0 text-muted-foreground" />
					<strong>{agent}</strong>
					{forWhom ? <span className="text-muted-foreground"> · {forWhom}</span> : null}
				</p>
				{builder ? (
					<p className={cn(SMALL, builder.status === "failed" ? "text-bad" : "text-neutral")}>
						Builder {builder.status}
						{builder.revisions ? ` (revision ${builder.revisions})` : ""}
						{builder.error ? `: ${builder.error}` : ""}
					</p>
				) : null}
				{claim ? <p className={cn(SMALL, "text-muted-foreground")}>Last active {timeAgo(claim.active)}</p> : null}
			</Section>
			<Section title="Claim">
				{record?.paths.length ? (
					<ul className={LIST}>
						{record.paths.map((path) => (
							<li key={path} className="flex min-w-0 items-center gap-1.5">
								<Icon
									name={path.endsWith("/") ? "folder" : "file"}
									size={14}
									className="shrink-0 text-muted-foreground"
								/>
								<ClaimedPath path={path} />
							</li>
						))}
					</ul>
				) : (
					<p className="m-0 text-muted-foreground">Released.</p>
				)}
				{lease ? (
					<p className={cn(SMALL, "mt-2 flex items-start gap-1.5", lease.free ? "text-warn" : "text-muted-foreground")}>
						<Icon name="clock" size={14} className="mt-0.5 shrink-0" />
						{lease.long}
					</p>
				) : null}
			</Section>
		</aside>
	);
}
