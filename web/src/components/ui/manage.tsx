import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Page } from "../Page";

// The pages that manage people and access (an organization, the Admin page, a repo's Access and Settings, your
// agents) share their rows and forms: a row's who or what on the left and its actions on the right, wrapping under it
// when there's no room; fields and a button on one line; terms and what they are, side by side.

/** A list of rows: no bullets, no indent. */
export const ROWS = "m-0 list-none p-0";

/** A row ruled off from the one above, the first too: a list's first row has a rule of its own under the header's. */
export const RULED = "border-t border-border px-0.5 py-3";

/**
 * A paragraph standing as a box's row, in place of its rows (loading, or none): ruled off from what's above it, but not
 * from the box's header, with a paragraph's own margins about it.
 */
export const LINE = "my-3.75 border-t border-border px-0.5 py-3 [[data-slot=box-header]+&]:border-t-0";

/** A row's line: what it's about, then its actions at the far end. */
export const ROW = "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2";

/** What a row is about: a name, then a word or two about it. */
export const ROW_MAIN = "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 wrap-anywhere";

export const ROW_ACTIONS = "flex flex-wrap items-center gap-1.5";

/** Fields and a button on one line, wrapping as they need. */
export const INLINE = "flex flex-wrap items-center gap-2";

/** A text field on such a line: it takes what room is left, from 180px up to 320px. */
export const INLINE_INPUT = "min-w-0 max-w-80 flex-[1_1_180px]";

/** A form's parts, a little apart. */
export const STACK = "grid gap-4";

/** A line saying what happened, a little smaller: saved, or what went wrong. */
export const NOTE = "m-0 text-ui";

/** Terms and what they are, side by side; one under the other on a narrow window. */
export const TERMS = [
	"m-0 grid grid-cols-[minmax(140px,max-content)_1fr] gap-x-5 gap-y-2.5 to-560:grid-cols-1 to-560:gap-1",
	"[&_dt]:font-semibold",
	"[&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-1.5 to-560:[&_dd]:mb-2",
].join(" ");

/** A page that manages an organization's or GitHive's people: its sections a little apart, under its header. */
export function ManagePage({ className, ...props }: ComponentProps<typeof Page>) {
	return <Page id="main" className={cn("grid gap-5", className)} {...props} />;
}

/** A managing page's header: its title and a line under it, and its actions at the far end. */
export function ManageHeader({ title, lede, actions }: { title: string; lede: ReactNode; actions?: ReactNode }) {
	return (
		<header className="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 className="text-display-sm tracking-[-0.01em]">{title}</h1>
				<p className="mt-1 mb-0 text-muted-foreground">{lede}</p>
			</div>
			{actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
		</header>
	);
}

/** A section's title on a managing page. */
export const TITLE = "text-lead";
