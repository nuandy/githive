import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { Counter } from "./ui/badge";

export interface TabItem {
	id: string;
	label: string;
	href: string;
	icon?: IconName;
	count?: number;
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

/** How many a tab holds; it bumps as the number changes. */
function TabCount({ count }: { count: number }) {
	const changed = useChanged(count);
	return (
		<Counter key={count} className={changed ? "animate-bump" : undefined}>
			{count}
		</Counter>
	);
}

/** Underlined navigation tabs; each is a link so the browser's back button works. */
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
	return (
		<nav
			className={cn(
				"overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
				className,
			)}
			aria-label={label}
		>
			<ul className="m-0 flex list-none gap-1 p-0 to-560:gap-0">
				{items.map((item) => (
					<li key={item.id}>
						<a href={item.href} className={tab} aria-current={item.id === current ? "page" : undefined}>
							{item.icon ? <Icon name={item.icon} className="to-560:hidden" /> : null}
							<span>{item.label}</span>
							{item.count !== undefined ? <TabCount count={item.count} /> : null}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
