import { useRef } from "react";

/**
 * Which of `counts` have changed since they were first drawn. Key each count's element by its value, so a new value is
 * a new element: given `animate-bump` while it's in this set, it bumps as it appears, and only then. The first draw
 * doesn't bump.
 */
export function useBumps<K extends string>(counts: Record<K, number>): Set<K> {
	const last = useRef<Record<K, number> | null>(null);
	const moved = useRef(new Set<K>());
	const before = last.current;
	if (before) for (const key of Object.keys(counts) as K[]) if (counts[key] !== before[key]) moved.current.add(key);
	last.current = counts;
	return moved.current;
}
