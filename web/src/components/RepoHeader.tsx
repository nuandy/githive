import type { ReactNode } from "react";
import type { LiveStatus } from "../lib/liveFeed";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Tabs, type TabItem } from "./Tabs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
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
						// More padding above than below, since Overpass's letters sit high in their line.
						"inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 pt-[3.5px] pb-[0.5px]",
						// On a phone, the dot and its word without the pill, so they keep the name's row.
						"to-560:border-0 to-560:px-0",
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

/** A link in the header that goes in its ⋯ menu on a phone: the repo's site, its GitHub repo, its pull request. */
export interface HeaderLink {
	label: string;
	href: string;
	icon: IconName;
	/** Opens outside the dashboard, in a new tab. */
	external?: boolean;
}

/** On a phone, the header's links in a menu of their own, so the name, its badge and the live dot keep one row. */
function HeaderMenu({ name, links }: { name: string; links: HeaderLink[] }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="hidden shrink-0 to-560:inline-flex"
					aria-label={`More for ${name}`}
				>
					<Icon name="more" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-w-[calc(100vw-32px)]">
				{links.map((link) => (
					<DropdownMenuItem key={link.href} asChild className="text-ui-lg hover:no-underline">
						<a
							href={link.href}
							{...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
							className="text-foreground"
						>
							<Icon name={link.icon} />
							<span className="wrap-anywhere">{link.label}</span>
						</a>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * A repo's name, whether it's public or private, the live dot and its links, then its tabs, which stick under the top
 * bar. It sits in the page's main landmark, so the skip link reaches the tabs.
 */
export function RepoHeader({
	name,
	tabs,
	current,
	homeHref,
	live = "off",
	heading = true,
	visibility,
	badges,
	aside,
	links = [],
}: {
	name: string;
	tabs: TabItem[];
	current: string;
	homeHref: string;
	live?: LiveStatus;
	/** The name is the page's heading, unless the page has one of its own (a change's title). */
	heading?: boolean;
	/** Who can see it, once known. */
	visibility?: "public" | "private" | null;
	/** Badges after the name, e.g. that all its work has landed. */
	badges?: ReactNode;
	/** At the far end: the GitHub repo it's connected to, say. On a phone its links go in the ⋯ menu (`links`). */
	aside?: ReactNode;
	/** The links `aside` shows, for the ⋯ menu that takes their place on a phone. */
	links?: HeaderLink[];
}) {
	const Name = heading ? "h1" : "p";
	return (
		<>
			<div className="bg-card">
				<div className="mx-auto max-w-(--page-width) px-6 pt-4.5 pb-2.5 to-560:px-4 to-560:pt-3.5">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						{/* The heading is the name alone; its badge and the live dot sit beside it, on one row on a phone. */}
						<div
							className={cn(
								"flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5",
								// On a phone they keep one row, the name shortened if it must be.
								"to-560:flex-[1_1_0] to-560:flex-nowrap to-560:gap-x-2",
							)}
						>
							<Name
								{...(heading ? { tabIndex: -1 } : {})}
								className="flex min-w-0 items-center gap-2 text-title leading-[1.2] font-normal tracking-[-0.01em]"
							>
								<Icon name="repo" className="shrink-0 text-muted-foreground to-560:hidden" />
								<a className="font-semibold wrap-anywhere to-560:truncate" href={homeHref}>
									{name}
								</a>
							</Name>
							{visibility ? (
								<Badge outline size="sm" className="shrink-0">
									{visibility === "public" ? "Public" : "Private"}
								</Badge>
							) : null}
							<LiveDot status={live} />
							{badges}
						</div>
						{aside ? (
							<div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 to-560:order-last to-560:ml-0 to-560:basis-full">
								{aside}
							</div>
						) : null}
						{links.length ? <HeaderMenu name={name} links={links} /> : null}
					</div>
				</div>
			</div>
			{/* The tabs stick under the top bar; their underline sits on the bar's own rule. */}
			<div className="sticky top-(--bar-height) z-5 border-b border-border bg-card">
				<div className="mx-auto max-w-(--page-width) px-6 to-560:px-4">
					<Tabs
						items={tabs}
						current={current}
						label={`${name} sections`}
						className="-mb-px border-b-0 [--tabs-fade:var(--card)]"
					/>
				</div>
			</div>
		</>
	);
}
