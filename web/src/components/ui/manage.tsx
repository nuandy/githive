import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Page, PageHeader } from "../Page";

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

/** A row's actions: at its far end, or on a line of their own under what it's about on a narrow window. */
export const ROW_ACTIONS = "flex flex-wrap items-center gap-1.5 to-560:basis-full";

/** Fields and a button on one line, wrapping as they need. */
export const INLINE = "flex flex-wrap items-center gap-2";

/** A text field on such a line: it takes what room is left, from 180px up to 320px. */
export const INLINE_INPUT = "min-w-0 max-w-80 flex-[1_1_180px]";

/** Labelled fields and a button on one line, the button level with the fields, wrapping as they need. */
export const INLINE_FIELDS = [
	"flex flex-wrap items-end gap-x-3 gap-y-2.5",
	// A text field, a select and the button, one height, whatever each would be on its own.
	"[&_[data-slot=input]]:h-9.5 [&_[data-slot=native-select]]:h-9.5 [&>[data-slot=button]]:h-9.5",
].join(" ");

/** A form that adds to a list: at the list's end, ruled off from its last row. */
export const ADD_FORM = "grid gap-2.5 border-t border-border px-0.5 py-4";

/**
 * "Saved", among a row's actions, by what was changed at once: a live region, there before it speaks, taking no room
 * (nor the gap before it) while it says nothing.
 */
export const SAVED_NOTE = "text-ui text-good empty:-ml-1.5";

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
	return <Page className={cn("grid gap-5", className)} {...props} />;
}

/** A managing page's header: the page's header (its title and a line under it, and its actions at the far end). */
export function ManageHeader({ title, lede, actions }: { title: string; lede: ReactNode; actions?: ReactNode }) {
	return <PageHeader className="mb-0" title={title} description={lede} actions={actions} />;
}

/** A section's title on a managing page. */
export const TITLE = "text-lead";
