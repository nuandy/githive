import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Fields: text, long text, a native select, and their labels. A field's border warms to the ring's color as it takes
// focus, with the ring itself fading in around it.

const field = [
	"min-w-0 rounded-md border border-border-strong bg-card px-2.5 py-1.5 text-foreground",
	"[font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]",
	"transition-[border-color,box-shadow] duration-fast ease-out",
	"focus-visible:border-ring focus-visible:shadow-focus focus-visible:outline-none",
	"disabled:cursor-not-allowed disabled:opacity-55",
];

export function Input({ className, ...props }: ComponentProps<"input">) {
	return <input data-slot="input" className={cn(field, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(field, "block min-h-18 w-full resize-y leading-[1.45]", className)}
			{...props}
		/>
	);
}

/** The browser's own select, in a field's box: its list is the system's, which suits a few plain choices. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
	return <select data-slot="native-select" className={cn(field, className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
	return <label data-slot="label" className={cn("font-semibold", className)} {...props} />;
}
