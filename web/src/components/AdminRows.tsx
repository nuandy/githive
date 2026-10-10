import type { ReactNode } from "react";

/** A section's list on the Admin page: loading, a note when it's empty, or one row per item. */
export function AdminRows<Item>({
	items,
	empty,
	children,
}: {
	items: Item[] | undefined;
	empty: string;
	children: (item: Item) => ReactNode;
}) {
	if (items === undefined) return <p className="muted box__body">Loading…</p>;
	if (items.length === 0) return <p className="muted box__body">{empty}</p>;
	return <ul className="manage__rows">{items.map((item) => children(item))}</ul>;
}

/** One row on the Admin page: who it is, a line about them, any error, and the actions on them. */
export function AdminRow({
	name,
	detail,
	error,
	children,
}: {
	name: string;
	detail: ReactNode;
	error: ReactNode;
	children: ReactNode;
}) {
	return (
		<li className="manage__row">
			<div className="manage__row-main">
				<strong>{name}</strong>
				<span className="muted">{detail}</span>
				{error}
			</div>
			<div className="manage__row-actions">{children}</div>
		</li>
	);
}
