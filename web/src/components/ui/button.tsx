import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// A button in the signal box's look: a ruled box on paper, the ink fill for a primary action, green for the go-ahead
// (merge, approve), red ink for what can't be undone. Colors and hover fade in rather than switch; focus is the
// outline every focusable thing has (theme.css).

export const buttonVariants = cva(
	[
		"inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
		"[font-family:inherit] [font-size:inherit] font-semibold leading-5 no-underline",
		"cursor-pointer rounded-md border",
		"transition-[color,background-color,border-color,opacity] duration-fast ease-out",
		"hover:no-underline",
		"disabled:cursor-not-allowed disabled:opacity-55",
	],
	{
		variants: {
			variant: {
				default: "border-input bg-card text-foreground hover:not-disabled:bg-surface-2",
				primary:
					"border-primary bg-primary text-primary-foreground hover:not-disabled:bg-[color-mix(in_srgb,var(--primary)_90%,#000)]",
				go: "border-good bg-good text-good-foreground hover:not-disabled:bg-[color-mix(in_srgb,var(--good)_88%,#000)]",
				danger:
					"border-input bg-card text-bad hover:not-disabled:border-bad hover:not-disabled:bg-bad hover:not-disabled:text-bad-foreground",
				ghost: "border-transparent bg-transparent text-foreground hover:not-disabled:bg-surface-2",
				link: "border-0 bg-transparent font-normal text-link hover:not-disabled:underline",
			},
			size: {
				default: "px-3.5 pt-1.5 pb-1.25",
				sm: "px-2.5 py-0.75 text-ui",
				icon: "size-8 p-0",
			},
		},
		// A link-like button has no box to pad.
		compoundVariants: [{ variant: "link", class: "p-0" }],
		defaultVariants: { variant: "default", size: "default" },
	},
);

export type ButtonProps = ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		/** Draw the button's look on the one child instead (a link that reads as a button). */
		asChild?: boolean;
	};

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
	const Comp = asChild ? Slot.Root : "button";
	return (
		<Comp
			data-slot="button"
			className={cn(buttonVariants({ variant, size }), className)}
			{...(asChild ? {} : { type: type ?? "button" })}
			{...props}
		/>
	);
}
