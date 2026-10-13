import type { ComponentProps } from "react";
import { useChanged } from "../../hooks/useChanged";
import { useLingering } from "../../hooks/useLingering";
import { cn } from "../../lib/utils";

// What opens and closes, folding its height rather than appearing at once: grid rows 0fr ↔ 1fr, so it folds to its
// content's own height without measuring it, fading as it goes. Closed, it stays in the page but out of reach (inert);
// Fold drops it once folded, and unfolds it again as it comes back.

export function Collapse({
	open,
	appear = false,
	className,
	children,
	...props
}: ComponentProps<"div"> & {
	open: boolean;
	/** Unfold from nothing as it mounts, rather than arrive open. */
	appear?: boolean;
}) {
	return (
		<div
			data-slot="collapse"
			data-state={open ? "open" : "closed"}
			inert={!open}
			className={cn(
				"grid [transition:grid-template-rows_var(--motion-slow)_var(--ease-out),opacity_var(--motion-base)_ease]",
				open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
				appear && "starting:grid-rows-[0fr] starting:opacity-0",
				className,
			)}
			{...props}
		>
			<div className="min-h-0 overflow-hidden">{children}</div>
		</div>
	);
}

/**
 * A Collapse that drops what it holds once it has folded away, and unfolds it again as it comes back. What's open from
 * the start arrives with its page, as it is.
 */
export function Fold({ open, ...props }: ComponentProps<typeof Collapse>) {
	// As long as the fold takes (--motion-slow).
	const present = useLingering(open, 400);
	const changed = useChanged(open);
	return present ? <Collapse open={open} appear={changed} {...props} /> : null;
}
