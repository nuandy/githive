import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import { Box } from "./ui/box";

// The dashboard's frame: the shell around every page, a page's centered column, and a page with nothing to show but
// a message.

/** The whole window: the top bar, then what's under it, in a column at least as tall as the window. */
export function Shell({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("flex min-h-screen flex-col", className)} {...props} />;
}

/**
 * For keyboard users: hidden above the window until it takes focus, then it slides down. It moves focus to the page's
 * main column without touching the address, which the router reads as a route.
 */
export function SkipLink() {
	const skip = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		document.getElementById("main")?.focus();
	};
	return (
		<a
			href="#main"
			onClick={skip}
			className="absolute -top-10 left-2 z-20 rounded-md bg-card px-3 py-1.5 transition-[top] duration-fast ease-out focus:top-2 focus:shadow-raised"
		>
			Skip to content
		</a>
	);
}

/**
 * A page's main column: centered, as wide as the theme's page at most, with room around it. The skip link focuses it,
 * so it takes focus without a ring.
 */
export function Page({ className, ...props }: ComponentProps<"main">) {
	return (
		<main
			id="main"
			tabIndex={-1}
			className={cn("mx-auto w-full max-w-(--page-width) min-w-0 p-6 outline-none to-560:p-4", className)}
			{...props}
		/>
	);
}

/** A page with nothing to show but a message: a heading and a line or two, centered under a rule. */
export function EmptyPage({ role, children }: { role?: "alert"; children: ReactNode }) {
	return (
		<Page>
			<Box
				role={role}
				className={cn(
					"px-6 py-10 text-center",
					"[&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-title",
					"[&_p]:mx-auto [&_p]:mt-0 [&_p]:mb-2 [&_p]:max-w-130 [&_p]:text-muted-foreground",
				)}
			>
				{children}
			</Box>
		</Page>
	);
}
