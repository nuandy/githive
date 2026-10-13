import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Pills, counters and lamps: the small marks that say how something stands. A tone is one of the lamps' meanings
// (good, bad, warn, needs a person), the link's slate blue (accent) or neutral; each comes soft or solid, and a size
// smaller beside a row's title (sm).

export const badgeVariants = cva(
	[
		"inline-flex items-center gap-1.25 whitespace-nowrap rounded-sm border border-transparent",
		"px-2 pt-0.5 pb-px text-meta leading-4.5 font-semibold",
		"transition-[color,background-color,border-color] duration-base",
		// A branch or path named in a pill wears the pill's face, not a code box of its own.
		"[&_code]:bg-transparent [&_code]:p-0 [&_code]:[font-size:inherit]",
	],
	{
		variants: {
			tone: {
				good: "bg-good-soft text-good",
				bad: "bg-bad-soft text-bad",
				warn: "bg-warn-soft text-warn",
				needs: "bg-needs-soft text-needs",
				accent: "bg-link-soft text-link",
				neutral: "bg-neutral-soft text-neutral",
			},
			solid: { true: "", false: "" },
			outline: { true: "border-border-strong bg-transparent font-medium text-muted-foreground", false: "" },
			// Each size says its line height again: cn() drops a line height that a font size follows.
			size: { default: "", sm: "py-0 text-micro leading-4.5", lg: "px-3 py-1.25 text-ui-lg leading-5" },
		},
		compoundVariants: [
			{ solid: true, tone: "good", class: "bg-good text-good-foreground" },
			{ solid: true, tone: "bad", class: "bg-bad text-bad-foreground" },
			{ solid: true, tone: "warn", class: "bg-warn text-warn-foreground" },
			{ solid: true, tone: "needs", class: "bg-needs text-needs-foreground" },
			{ solid: true, tone: "accent", class: "bg-primary text-primary-foreground" },
			{ solid: true, tone: "neutral", class: "bg-neutral text-card" },
		],
		defaultVariants: { tone: "neutral", solid: false, outline: false, size: "default" },
	},
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, solid, outline, size, ...props }: BadgeProps) {
	return <span data-slot="badge" className={cn(badgeVariants({ tone, solid, outline, size }), className)} {...props} />;
}

/** A count beside a label: a tab's changes, the inbox's waiting. */
export function Counter({ className, ...props }: ComponentProps<"span">) {
	return (
		<span
			data-slot="counter"
			className={cn(
				"inline-block min-w-5 rounded-sm bg-surface-3 px-1.5 pt-px text-center text-caption leading-4.5 font-semibold text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export type LampColor = "amber" | "green" | "red" | "neutral";

const LAMP: Record<LampColor, string> = {
	amber: "[--lamp:var(--amber)]",
	green: "[--lamp:var(--good)]",
	red: "[--lamp:var(--bad)]",
	neutral: "[--lamp:var(--border-strong)]",
};

/** A lamp: amber, green or red, and always the same meaning (theme.css). Without a color it takes the one set around it. */
export function Lamp({ color, className, ...props }: ComponentProps<"span"> & { color?: LampColor }) {
	return (
		<span
			data-slot="lamp"
			aria-hidden="true"
			className={cn(
				"inline-block size-2.5 flex-none rounded-full bg-[var(--lamp,var(--border-strong))] transition-[background-color] duration-slow",
				color ? LAMP[color] : "",
				className,
			)}
			{...props}
		/>
	);
}
