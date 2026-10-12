import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// What opens and closes, folding its height rather than appearing at once: grid rows 0fr ↔ 1fr, so it folds to its
// content's own height without measuring it, fading as it goes. Closed, it stays in the page but out of reach (inert);
// to drop it once folded, pair it with useLingering.

export function Collapse({
	open,
	className,
	children,
	...props
}: ComponentProps<"div"> & {
	open: boolean;
}) {
	return (
		<div
			data-slot="collapse"
			data-state={open ? "open" : "closed"}
			inert={!open}
			className={cn(
				"grid [transition:grid-template-rows_var(--motion-slow)_var(--ease-out),opacity_var(--motion-base)_ease]",
				open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
				className,
			)}
			{...props}
		>
			<div className="min-h-0 overflow-hidden">{children}</div>
		</div>
	);
}
