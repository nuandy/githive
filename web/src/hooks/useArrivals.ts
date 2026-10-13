import { useState } from "react";

/**
 * Which of a list's items have come since it first showed, by key. What's there from the start arrives with the list
 * (or its page), which animates already; what comes later fades in on its own as it does.
 */
export function useArrivals(keys: string[]): (key: string) => boolean {
	const [first] = useState(() => new Set(keys));
	return (key) => !first.has(key);
}
