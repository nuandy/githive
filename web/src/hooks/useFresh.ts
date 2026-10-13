import { useRef } from "react";

/**
 * Whether what's drawn under a key has only just appeared, for `ms` after it did, so a redraw midway doesn't cut its
 * animation short. What's there on the first draw once `ready` isn't: the view opens settled, and only what comes
 * later arrives. Ask about every key drawn, every draw: asking is what marks a key seen.
 */
export function useFresh(ready: boolean, ms = 800): (key: string) => boolean {
	const seen = useRef<Map<string, number> | null>(null);
	const first = ready && seen.current === null;
	if (first) seen.current = new Map();
	const at = Date.now();
	return (key) => {
		const map = seen.current;
		if (!map) return false;
		const when = map.get(key);
		if (when === undefined) {
			map.set(key, first ? 0 : at);
			return !first;
		}
		return at - when < ms;
	};
}
