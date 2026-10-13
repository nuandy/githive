import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import { Box } from "./ui/box";

// The dashboard's frame: the shell around every page, its main landmark, a page's centered column and header, and a
// page with nothing to show but a message. Every page is as wide as the theme's --page-width at most, and no narrower.

/** The whole window: the top bar, then what's under it, in a column at least as tall as the window. */
export function Shell({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("flex min-h-screen flex-col", className)} {...props} />;
}

/**
 * For keyboard users: hidden above the window until it takes focus, then it slides down. It moves focus to the page's
 * main landmark without touching the address, which the router reads as a route.
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

/** The page's centered column: as wide as the theme's page at most, with room around it. */
export const COLUMN = "mx-auto w-full max-w-(--page-width) min-w-0 p-6 to-560:p-4";

/**
 * A page's main landmark, edge to edge: a repo's header and tabs sit in it, over its column. The skip link focuses it,
 * so it takes focus without a ring.
 */
export function Main({ className, ...props }: ComponentProps<"main">) {
	return <main id="main" tabIndex={-1} className={cn("min-w-0 outline-none", className)} {...props} />;
}

/** A page's main column: the main landmark, centered, as wide as the theme's page at most. */
export function Page({ className, ...props }: ComponentProps<"main">) {
	return <Main className={cn(COLUMN, className)} {...props} />;
}

/**
 * A page's one heading. Moving to the page focuses it (hooks/useHashRoute.ts), so a screen reader starts there; it
 * isn't a control, so it shows no ring.
 */
export function PageTitle({ className, ...props }: ComponentProps<"h1">) {
	return <h1 tabIndex={-1} className={cn("text-display tracking-[-0.01em] wrap-anywhere", className)} {...props} />;
}

/** A page's header: its title, a line about it, and its actions at the far end, wrapping under it when there's no room. */
export function PageHeader({
	title,
	description,
	actions,
	className,
	children,
}: {
	title: ReactNode;
	/** A line or two about the page, under its title. */
	description?: ReactNode;
	/** Buttons or links for the whole page, at the far end. */
	actions?: ReactNode;
	className?: string;
	/** More under the title and its line: a summary, say. */
	children?: ReactNode;
}) {
	return (
		<header data-slot="page-header" className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
			<div className="grid min-w-0 gap-1.5">
				<PageTitle>{title}</PageTitle>
				{description ? <p className="m-0 max-w-measure text-muted-foreground">{description}</p> : null}
				{children}
			</div>
			{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
		</header>
	);
}

/** A page with nothing to show but a message: its title and a line or two, centered under a rule. */
export function EmptyPage({ role, title, children }: { role?: "alert"; title: ReactNode; children: ReactNode }) {
	return (
		<Page>
			<Box
				role={role}
				className={cn(
					"px-6 py-10 text-center",
					"[&_p]:mx-auto [&_p]:mt-0 [&_p]:mb-2 [&_p]:max-w-130 [&_p]:text-muted-foreground",
				)}
			>
				<PageTitle className="mt-3 mb-2 text-title">{title}</PageTitle>
				{children}
			</Box>
		</Page>
	);
}
