import type { ReactNode } from "react";
import type { LiveStatus } from "../lib/liveFeed";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Tabs, type TabItem } from "./Tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const LIVE_WORDS: Record<Exclude<LiveStatus, "off">, { label: string; title: string }> = {
	live: { label: "Live", title: "Connected: this page updates as soon as anything changes." },
	connecting: {
		label: "Connecting",
		title: "Connecting to live updates; until then the page refreshes every few seconds.",
	},
	reconnecting: {
		label: "Reconnecting",
		title: "Live updates dropped; reconnecting. Until then the page refreshes every few seconds.",
	},
};

// Live, the lamp is green and breathes; on the way there it's amber.
const DOT: Record<Exclude<LiveStatus, "off">, string> = {
	live: "bg-good [box-shadow:0_0_0_3px_color-mix(in_srgb,var(--good)_25%,transparent)] animate-live motion-reduce:animate-none",
	connecting: "bg-warn",
	reconnecting: "bg-warn",
};

export function LiveDot({ status }: { status: LiveStatus }) {
	if (status === "off") return null;
	const words = LIVE_WORDS[status];
	// What the state means shows on hover or focus.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5",
						"text-caption font-medium text-muted-foreground transition-colors duration-base",
						status === "live" && "text-good",
					)}
					tabIndex={0}
					role="status"
					aria-live="polite"
				>
					<span className={cn("size-2 rounded-full transition-colors duration-base", DOT[status])} aria-hidden="true" />
					{words.label}
				</span>
			</TooltipTrigger>
			<TooltipContent>{words.title}</TooltipContent>
		</Tooltip>
	);
}

/** A repo's name, badges and tabs, at the top of every page in it. */
export function RepoHeader({
	name,
	tabs,
	current,
	homeHref,
	live = "off",
	heading = true,
	badges,
	aside,
}: {
	name: string;
	tabs: TabItem[];
	current: string;
	homeHref: string;
	live?: LiveStatus;
	/** The name is the page's heading, unless the page has one of its own (a change's title). */
	heading?: boolean;
	/** Badges after the name, e.g. how claims are kept. */
	badges?: ReactNode;
	/** Beside the name: the GitHub repo it's connected to, say. */
	aside?: ReactNode;
}) {
	const Name = heading ? "h1" : "p";
	return (
		<div className="border-b border-border bg-card">
			<div className="mx-auto max-w-(--page-width) px-6 pt-4.5 to-560:px-4 to-560:pt-3.5">
				<div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					{/* The heading is the name alone; the badges sit beside it in the same type. */}
					<div className="flex flex-wrap items-center gap-2 text-title leading-[1.2] tracking-[-0.01em]">
						<Name className="flex flex-wrap items-center gap-2 font-normal">
							<Icon name="repo" className="text-muted-foreground" />
							<a className="font-semibold wrap-anywhere" href={homeHref}>
								{name}
							</a>
						</Name>
						{badges}
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						{aside}
						<LiveDot status={live} />
					</div>
				</div>
				{/* The tabs' underline sits on the header's own rule. */}
				<Tabs items={tabs} current={current} label={`${name} sections`} className="-mb-px border-b-0" />
			</div>
		</div>
	);
}
