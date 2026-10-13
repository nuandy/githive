import { type RefObject, useEffect, useRef, useState } from "react";
import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Counter } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface TabItem {
	id: string;
	label: string;
	href: string;
	icon?: IconName;
	count?: number;
	/** Why there's nothing to show here yet: the tab is dimmed, not a link, and says why in a tooltip. */
	unavailable?: string;
}

// A tab: muted until hovered or chosen; the chosen one is underlined in ink, and the underline fades across as the
// choice moves. On a phone the tabs tighten and drop their icons, so a page's three fit without scrolling.
const tab = cn(
	"relative inline-flex items-center gap-2 rounded-t-md px-3 pt-2.5 pb-2.75 whitespace-nowrap to-560:gap-1.5 to-560:px-2",
	"font-medium text-muted-foreground transition-colors duration-fast hover:bg-surface-2 hover:text-foreground hover:no-underline",
	"aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
	"after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-xs after:bg-primary",
	"after:opacity-0 after:transition-opacity after:duration-fast aria-[current=page]:after:opacity-100",
	"focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
);

// A tab with nothing to show yet: an inactive control, dimmed (WCAG leaves inactive controls out of its contrast
// minimum), its label dashed underneath so more than its color says so.
const unavailableTab = cn(
	tab,
	"cursor-default text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60",
	"[&>span:first-of-type]:underline [&>span:first-of-type]:decoration-border-strong [&>span:first-of-type]:decoration-dashed",
	"[&>span:first-of-type]:underline-offset-4",
);

/** How many a tab holds; it bumps as the number changes. */
function TabCount({ count }: { count: number }) {
	const changed = useChanged(count);
	return (
		<Counter key={count} className={changed ? "animate-bump" : undefined}>
			{count}
		</Counter>
	);
}

/** Which ends of a row that scrolls sideways have more past them. */
function useOverflow(row: RefObject<HTMLElement | null>) {
	const [more, setMore] = useState({ start: false, end: false });
	useEffect(() => {
		const element = row.current;
		if (!element) return;
		const measure = () => {
			const start = element.scrollLeft > 1;
			const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
			setMore((was) => (was.start === start && was.end === end ? was : { start, end }));
		};
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [row]);
	return more;
}

// The fade at an end with more past it, from what the tabs sit on (--tabs-fade: the page, or a header's card), so the
// tabs look to go on under it.
const fade = "pointer-events-none absolute inset-y-0 w-8 transition-opacity duration-fast";

/**
 * Underlined navigation tabs; each is a link so the browser's back button works. In a narrow window they scroll
 * sideways: the current one is scrolled into view, and an end with more past it fades out.
 */
export function Tabs({
	items,
	current,
	label,
	className,
}: {
	items: TabItem[];
	current: string;
	label: string;
	className?: string;
}) {
	const row = useRef<HTMLElement>(null);
	const more = useOverflow(row);
	// The current tab in view as it's chosen, and again as the tabs settle (their font loads, a count comes), until
	// the reader scrolls them.
	useEffect(() => {
		const element = row.current;
		if (!element) return;
		let touched = false;
		const show = () => {
			if (touched) return;
			element.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
		};
		const touch = () => {
			touched = true;
		};
		show();
		// Each tab, which grows as its font loads; and the row, as the window changes.
		const observer = new ResizeObserver(show);
		observer.observe(element);
		for (const each of element.querySelectorAll("li")) observer.observe(each);
		const touches = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
		for (const name of touches) element.addEventListener(name, touch, { passive: true });
		return () => {
			observer.disconnect();
			for (const name of touches) element.removeEventListener(name, touch);
		};
	}, [current]);
	return (
		<div className={cn("relative min-w-0 border-b border-border [--tabs-fade:var(--background)]", className)}>
			<nav
				ref={row}
				className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				aria-label={label}
			>
				<ul className="m-0 flex list-none gap-1 p-0 to-560:gap-0">
					{items.map((item) => {
						const isCurrent = item.id === current;
						const inner = (
							<>
								{item.icon ? <Icon name={item.icon} className="to-560:hidden" /> : null}
								<span>{item.label}</span>
								{item.count !== undefined ? <TabCount count={item.count} /> : null}
							</>
						);
						return (
							<li key={item.id}>
								{item.unavailable && !isCurrent ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<span className={unavailableTab} role="link" aria-disabled="true" tabIndex={0}>
												{inner}
												<span className="sr-only">, {item.unavailable}</span>
											</span>
										</TooltipTrigger>
										<TooltipContent>{item.unavailable}</TooltipContent>
									</Tooltip>
								) : (
									<a href={item.href} className={tab} aria-current={isCurrent ? "page" : undefined}>
										{inner}
									</a>
								)}
							</li>
						);
					})}
				</ul>
			</nav>
			<span
				aria-hidden="true"
				data-slot="tabs-fade"
				className={cn(fade, "left-0 bg-linear-to-r from-(--tabs-fade)", more.start ? "opacity-100" : "opacity-0")}
			/>
			<span
				aria-hidden="true"
				data-slot="tabs-fade"
				className={cn(fade, "right-0 bg-linear-to-l from-(--tabs-fade)", more.end ? "opacity-100" : "opacity-0")}
			/>
		</div>
	);
}
