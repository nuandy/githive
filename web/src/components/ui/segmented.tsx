import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// A few choices side by side in one ruled box, the chosen one pressed: a time range, a view. A group of toggle
// buttons (role="group", aria-pressed), so each choice is a button by its words.

export function Segmented<T extends string | number>({
	label,
	options,
	value,
	onPick,
	className,
	...props
}: Omit<ComponentProps<"div">, "onChange"> & {
	/** What the choices are of, for whoever can't see them. */
	label: string;
	options: { value: T; words: string }[];
	value: T;
	onPick(value: T): void;
}) {
	return (
		<div
			data-slot="segmented"
			role="group"
			aria-label={label}
			className={cn("inline-flex overflow-hidden rounded-md border border-border-strong", className)}
			{...props}
		>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === value}
					className={cn(
						"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-none border-0 bg-transparent px-2.5 py-0.5",
						"[font-family:inherit] text-caption leading-5 font-semibold whitespace-nowrap text-muted-foreground no-underline",
						"transition-[background-color,color] duration-200 ease-[ease] not-first:border-l not-first:border-border",
						"hover:not-aria-pressed:bg-surface-2 aria-pressed:bg-surface-3 aria-pressed:text-foreground",
						"focus-visible:border-ring focus-visible:shadow-focus focus-visible:outline-none",
					)}
					onClick={() => onPick(option.value)}
				>
					{option.words}
				</button>
			))}
		</div>
	);
}
