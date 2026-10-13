import type { ReactNode } from "react";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { ROW, ROW_ACTIONS, ROW_MAIN, ROWS } from "./ui/manage";

// A line in place of the rows: a box's padding, with a paragraph's margins about it.
const LINE = "my-3.75 px-0.5 py-4 text-muted-foreground";

/**
 * A section's list on the Admin page: loading, a note when it's empty, or one row per item. What's read fades in as it
 * takes the place of "Loading…", and an item that comes later fades in on its own.
 */
export function AdminRows<Item>({
	items,
	keyOf,
	empty,
	children,
}: {
	items: Item[] | undefined;
	keyOf: (item: Item) => string;
	empty: string;
	children: (item: Item, arrived: boolean) => ReactNode;
}) {
	const read = useChanged(items === undefined) && "animate-appear";
	const arrived = useArrivals((items ?? []).map(keyOf));
	if (items === undefined) return <p className={LINE}>Loading…</p>;
	if (items.length === 0) return <p className={cn(LINE, read)}>{empty}</p>;
	return <ul className={ROWS}>{items.map((item) => children(item, arrived(keyOf(item))))}</ul>;
}

/** One row on the Admin page: who it is, a line about them, any error, and the actions on them. */
export function AdminRow({
	name,
	detail,
	error,
	arrived,
	children,
}: {
	name: string;
	detail: ReactNode;
	error: ReactNode;
	/** Come since the list was first read: it fades in. */
	arrived: boolean;
	children: ReactNode;
}) {
	return (
		<li className={cn(ROW, arrived && "animate-appear")}>
			<div className={ROW_MAIN}>
				<strong>{name}</strong>
				<span className="text-muted-foreground">{detail}</span>
				{error}
			</div>
			<div className={ROW_ACTIONS}>{children}</div>
		</li>
	);
}
