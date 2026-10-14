import { useLayoutEffect, useRef } from "react";

/**
 * What had focus as an overlay opened, to go back to as it closes. An item of a menu stands for the button that opened
 * the menu, which outlives it.
 */
export function focusOrigin(active: Element | null): HTMLElement | null {
	if (!(active instanceof HTMLElement) || active === document.body) return null;
	const menu = active.closest('[role="menu"]');
	const label = menu?.getAttribute("aria-labelledby");
	return (label ? document.getElementById(label) : null) ?? active;
}

/**
 * For an overlay with no trigger of its own for Radix to go back to (the palette, the list of shortcuts, a dialog a
 * menu's item opens): its `onCloseAutoFocus`, which puts focus back on what had it as it opened, or on `fallback()`
 * once that's gone, rather than on the page's body.
 */
export function useReturnFocus(open: boolean, fallback?: () => HTMLElement | null | undefined) {
	const origin = useRef<HTMLElement | null>(null);
	// Before the overlay's own focus moves into it (an effect).
	useLayoutEffect(() => {
		if (open) origin.current = focusOrigin(document.activeElement);
	}, [open]);
	return (event: Event) => {
		event.preventDefault();
		const back = origin.current?.isConnected ? origin.current : fallback?.();
		origin.current = null;
		// Focus the reader has moved on meanwhile, out of the overlay, stays.
		const active = document.activeElement;
		const overlay = event.target instanceof Node ? event.target : null;
		if (active && active !== document.body && overlay && !overlay.contains(active)) return;
		back?.focus();
	};
}
