import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

// The foot of a form that saves: a line saying what happened (saved, or what went wrong) and, at the far end, Discard
// and Save. It stays in view at the bottom of the window while its section scrolls past, over a fade of the page.
// Save submits the form, in ink: green is for landing and approving. Both wait while there's nothing to save or a save
// is under way.

export function SaveBar({
	status,
	dirty,
	busy = false,
	onDiscard,
	canDiscard = dirty,
	saveLabel = "Save",
	discardLabel = "Discard",
	className,
	...props
}: Omit<ComponentProps<"div">, "children"> & {
	/** What the last save said, or what's wrong with the form. */
	status?: ReactNode;
	/** Whether there are edits to save or discard. */
	dirty: boolean;
	/** A save is under way. */
	busy?: boolean;
	onDiscard(): void;
	/** Whether Discard does anything: while there are edits, unless told otherwise (closing an editor, say). */
	canDiscard?: boolean;
	saveLabel?: string;
	discardLabel?: string;
}) {
	return (
		<div
			data-slot="save-bar"
			className={cn(
				"sticky bottom-0 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 py-3",
				"bg-[linear-gradient(to_bottom,transparent,var(--background)_30%)]",
				className,
			)}
			{...props}
		>
			<p className="m-0 mr-auto min-w-0 text-ui wrap-anywhere text-muted-foreground" role="status">
				{status}
			</p>
			<div className="flex gap-2">
				<Button disabled={busy || !canDiscard} onClick={onDiscard}>
					{discardLabel}
				</Button>
				<Button type="submit" variant="primary" disabled={busy || !dirty}>
					{busy ? "Saving…" : saveLabel}
				</Button>
			</div>
		</div>
	);
}
