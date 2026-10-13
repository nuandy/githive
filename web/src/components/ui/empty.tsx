import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Nothing to show yet: an icon, a heading and a line or two saying what will show here, centered. Its parts are plain
// elements (an Icon, an <h2>, paragraphs), set out from here. In a box of its own: <Box asChild><Empty>.

export function Empty({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="empty"
			className={cn(
				"px-6 py-10 text-center",
				// The icon has a line of its own above the heading, sitting on the text's baseline as an inline icon does.
				"[&>svg]:inline [&>svg]:align-baseline [&>svg]:text-muted-foreground",
				"[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-title",
				"[&_p]:mx-auto [&_p]:mt-0 [&_p]:mb-2 [&_p]:max-w-130 [&_p]:text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}
