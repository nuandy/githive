import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Boxes are ruled sections, not cards: a heavy rule above, a light one between rows, no panel or shadow. A callout
// is a note with a colored rule down its side.

export function Box({
	className,
	asChild = false,
	...props
}: ComponentProps<"section"> & {
	/** Rule the one child instead (a form that is a box). */
	asChild?: boolean;
}) {
	const Comp = asChild ? Slot.Root : "section";
	return <Comp data-slot="box" className={cn("min-w-0 border-t-2 border-foreground", className)} {...props} />;
}

export function BoxHeader({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="box-header"
			className={cn(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-0.5 pt-2.5 pb-2.25 font-bold",
				className,
			)}
			{...props}
		/>
	);
}

export function BoxBody({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="box-body" className={cn("px-0.5 py-4", className)} {...props} />;
}

/** A row in a box, ruled off from the one above; the first, or the one under the header, isn't. */
export function BoxRow({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="box-row"
			className={cn(
				"border-t border-border px-0.5 py-3 first:border-t-0 [[data-slot=box-header]+&]:border-t-0",
				className,
			)}
			{...props}
		/>
	);
}

export const calloutVariants = cva(
	[
		"flex items-start gap-2.5 border-l-3 px-3.5 py-3 wrap-anywhere",
		"transition-[background-color,border-color] duration-base",
		"[&>svg]:mt-0.5 [&>svg]:shrink-0 [&_p]:mt-0.5 [&_p]:mb-0",
	],
	{
		variants: {
			tone: {
				neutral: "border-border-strong bg-surface-2",
				bad: "border-bad bg-bad-soft",
				warn: "border-amber bg-warn-soft",
				needs: "border-needs bg-needs-soft",
				good: "border-good bg-good-soft",
			},
		},
		defaultVariants: { tone: "neutral" },
	},
);

export function Callout({ className, tone, ...props }: ComponentProps<"div"> & VariantProps<typeof calloutVariants>) {
	return <div data-slot="callout" className={cn(calloutVariants({ tone }), className)} {...props} />;
}
