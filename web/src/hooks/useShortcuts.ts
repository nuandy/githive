import { useEffect, useRef } from "react";
import { keysTaken, readShortcut, type Shortcut } from "../lib/shortcuts";

/** A dialog open over the page, other than the palette itself (which ⌘K closes again). */
const OPEN_DIALOG =
	'[data-slot="dialog-content"][data-state="open"]:not([data-palette]), [data-slot="alert-dialog-content"][data-state="open"]';

/**
 * Listens for the keyboard's shortcuts (lib/shortcuts.ts) and hands each to `run`, which says whether it did
 * anything; a shortcut that did keeps its key from the page. Keys pressed in a field, a form, an open menu or a dialog
 * are theirs; ⌘K opens the palette from anywhere but over another dialog.
 */
export function useShortcuts(run: (shortcut: Shortcut) => boolean) {
	const latest = useRef(run);
	latest.current = run;
	useEffect(() => {
		let pending: number | null = null;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const target = event.target instanceof Element ? event.target : null;
			const read = readShortcut(
				{
					key: event.key,
					metaKey: event.metaKey,
					ctrlKey: event.ctrlKey,
					altKey: event.altKey,
					typing: keysTaken(target),
					dialog: !!document.querySelector(OPEN_DIALOG),
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
