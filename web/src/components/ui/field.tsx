import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Fields: text, long text, a native select, their labels, and a field's label, control and hint together. A field's
// border warms to the ring's color as it takes focus, with the ring itself fading in around it.

const field = [
	"min-w-0 rounded-md border border-border-strong bg-card px-2.5 py-1.5 text-foreground",
	"[font-family:inherit] [font-size:inherit] [font-weight:inherit] leading-[inherit]",
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

/** A field in a form: its label, the control, and a hint under it, a little apart. */
export function Field({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="field" className={cn("grid min-w-0 gap-1.5", className)} {...props} />;
}

/** What's said under a field: what goes in it, or what's wrong with what does. */
export function FieldHint({ className, ...props }: ComponentProps<"p">) {
	return <p data-slot="field-hint" className={cn("m-0 text-ui text-muted-foreground", className)} {...props} />;
}
