import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { parseRoute, type Route } from "../lib/routes";
import { ScrollMemory, entryKeyOf, reachable, withEntryKey } from "../lib/scrollMemory";

// The address as a route, and what moving between routes does to the window: a new place starts at the top with its
// heading focused, so a screen reader starts there; Back and Forward go back to where each entry was scrolled, once
// the page has filled in enough to scroll that far; a new tab of the same place stays where it is.

/** Where a route points, ignoring tabs. Moving to a new place scrolls to the top and focuses its heading. */
export function routePlace(route: Route): string {
	if (route.page === "repo") return `repo:${route.repo}`;
	if (route.page === "change") return `change:${route.repo}:${route.change}`;
	if (route.page === "org") return `org:${route.org}`;
	return route.page;
}

// Moving between files in the Code tab scrolls to the top too, without remounting the page.
function scrollPlace(route: Route): string {
	const inCode = route.page === "repo" && route.tab === "code";
	const codePlace = inCode ? `:code:${route.path ?? ""}:${route.ref ?? ""}` : "";
	return `${routePlace(route)}${codePlace}`;
}

/**
 * Changes the address without a new history entry (a search typed, a view chosen), keeping the entry's own state.
 * The route doesn't change with it: what changed it already shows it.
 */
export function replaceHash(hash: string) {
	if (window.location.hash === hash || (hash === "#/" && !window.location.hash)) return;
	window.history.replaceState(window.history.state, "", hash);
}

/** How long a page may take to fill in before a restore or a focus gives up waiting. */
const WAIT_MS = 5_000;

/** Scrolls back to `y` once the page is tall enough, unless the reader scrolls first. Returns a way to stop. */
function restoreScroll(y: number, memory: ScrollMemory): () => void {
	memory.hold();
	let done = false;
	const interrupts = ["wheel", "touchstart", "keydown", "mousedown"] as const;
	const finish = () => {
		if (done) return;
		done = true;
		memory.release();
		observer.disconnect();
		window.clearTimeout(timer);
		for (const name of interrupts) window.removeEventListener(name, finish);
		memory.scrolled(window.scrollY);
	};
	const attempt = () => {
		const page = { scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight };
		if (!reachable(y, page)) return;
		window.scrollTo(0, y);
		finish();
	};
	const observer = new ResizeObserver(attempt);
	observer.observe(document.body);
	for (const name of interrupts) window.addEventListener(name, finish, { passive: true });
	// As far as it goes, if the page never grows that tall.
	const timer = window.setTimeout(() => {
		window.scrollTo(0, y);
		finish();
	}, WAIT_MS);
	attempt();
	return finish;
}

/**
 * Focuses the page's heading as soon as it shows, with no ring (theme.css): what was focused went with the page, or
 * was the link that moved here. Focus the reader has moved on meanwhile stays. Returns a way to stop waiting.
 */
function focusHeading(from: Element | null): () => void {
	const tryFocus = () => {
		const active = document.activeElement;
		const moved = active && active !== document.body && active !== from && active.isConnected;
		if (moved) return true;
		const heading = document.querySelector<HTMLElement>("#main h1") ?? document.querySelector<HTMLElement>("h1");
		if (!heading) return false;
		if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
		heading.focus({ preventScroll: true });
		return true;
	};
	if (tryFocus()) return () => undefined;
	const observer = new MutationObserver(() => {
		if (tryFocus()) stop();
	});
	const stop = () => {
		observer.disconnect();
		window.clearTimeout(timer);
	};
	observer.observe(document.body, { childList: true, subtree: true });
	const timer = window.setTimeout(stop, WAIT_MS);
	return stop;
}

interface Pending {
	scroll: number | "top" | null;
	focus: boolean;
	from: Element | null;
}

/** The route the address names, kept current as it changes. */
export function useHashRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
	const memory = useRef<ScrollMemory | null>(null);
	const pending = useRef<Pending | null>(null);
	const stops = useRef<(() => void)[]>([]);

	useEffect(() => {
		if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
		const kept = entryKeyOf(window.history.state);
		const remembered = (memory.current ??= new ScrollMemory(kept));
		if (!kept) window.history.replaceState(withEntryKey(window.history.state, remembered.current), "");
		let shown = parseRoute(window.location.hash);
		const onScroll = () => remembered.scrolled(window.scrollY);
		const onChange = () => {
			for (const stop of stops.current.splice(0)) stop();
			const next = parseRoute(window.location.hash);
			const arrival = remembered.arrive(entryKeyOf(window.history.state), scrollPlace(next) !== scrollPlace(shown));
			if (arrival.fresh) window.history.replaceState(withEntryKey(window.history.state, arrival.key), "");
			// A new place starts at the top at once; going back waits for the page to show.
			if (arrival.scroll === "top") window.scrollTo(0, 0);
			const focus = routePlace(next) !== routePlace(shown);
			pending.current = { scroll: arrival.scroll, focus, from: document.activeElement };
			shown = next;
			setRoute(next);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("hashchange", onChange);
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("hashchange", onChange);
			for (const stop of stops.current.splice(0)) stop();
		};
	}, []);

	// Once the new route has rendered: back to where the entry was, and the heading focused.
	useLayoutEffect(() => {
		const next = pending.current;
		pending.current = null;
		if (!next || !memory.current) return;
		if (typeof next.scroll === "number") stops.current.push(restoreScroll(next.scroll, memory.current));
		if (next.focus) stops.current.push(focusHeading(next.from));
	}, [route]);

	return route;
}
