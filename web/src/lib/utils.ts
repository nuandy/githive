import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Joins class names, the later winning where two set the same thing (cn("px-2", wide && "px-4")). tailwind-merge
// knows Tailwind's own scales; the theme's names (theme.css) are taught here, or text-meta and text-muted-foreground
// would look like two colors and one would be dropped.

const merge = extendTailwindMerge({
	extend: {
		theme: {
			text: [
				"micro",
				"caption",
				"meta",
				"ui",
				"ui-lg",
				"body-sm",
				"body",
				"lead",
				"title-sm",
				"title",
				"title-lg",
				"display-sm",
				"display",
			],
			container: ["measure"],
			shadow: ["raised"],
			ease: ["spring", "pop"],
			animate: ["appear", "fade", "leave", "bump", "pop", "live"],
		},
		classGroups: { duration: [{ duration: ["fast", "base", "slow"] }] },
	},
});

export function cn(...inputs: ClassValue[]) {
	return merge(clsx(inputs));
}
