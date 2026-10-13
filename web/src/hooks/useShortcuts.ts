import { useEffect, useRef } from "react";
import { readShortcut, type Shortcut, typingIn } from "../lib/shortcuts";

/**
 * Listens for the keyboard's shortcuts (lib/shortcuts.ts) and hands each to `run`, which says whether it did
 * anything; a shortcut that did keeps its key from the page. Inside an open menu or dialog, only ⌘K counts.
 */
export function useShortcuts(run: (shortcut: Shortcut) => boolean) {
	const latest = useRef(run);
	latest.current = run;
	useEffect(() => {
		let pending: number | null = null;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const target = event.target instanceof Element ? event.target : null;
			const inOverlay = !!target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
			const typing = inOverlay || typingIn(target as HTMLInputElement | null);
			const read = readShortcut(
				{
					key: event.key,
					metaKey: event.metaKey,
					ctrlKey: event.ctrlKey,
					altKey: event.altKey,
					typing,
					at: event.timeStamp,
				},
				pending,
			);
			pending = read.pending;
			if (read.shortcut && latest.current(read.shortcut)) event.preventDefault();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
