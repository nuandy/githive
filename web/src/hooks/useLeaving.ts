import { useEffect, useRef, useState } from "react";
import { reducedMotion } from "../lib/motion";

/**
 * What was drawn last time and is gone now, kept `ms` longer where it was, so it can fade or shrink away instead of
 * vanishing. Items are told apart by `keyOf`; one that comes back stops leaving. Under reduced motion nothing shrinks
 * away, so nothing is kept.
 */
export function useLeaving<T>(items: T[], keyOf: (item: T) => string, ms: number): T[] {
	const last = useRef(new Map<string, T>());
	const [leaving, setLeaving] = useState<T[]>([]);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const now = new Map(items.map((each) => [keyOf(each), each]));
		const gone = [...last.current.values()].filter((each) => !now.has(keyOf(each)));
		last.current = now;
		if (!gone.length || reducedMotion()) return;
		setLeaving((current) => [...current.filter((each) => !now.has(keyOf(each))), ...gone]);
		const timer = setTimeout(() => {
			timers.current.delete(timer);
			setLeaving((current) => current.filter((each) => !gone.includes(each)));
		}, ms);
		timers.current.add(timer);
	});
	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	if (reducedMotion()) return [];
	const now = new Set(items.map(keyOf));
	return leaving.filter((each) => !now.has(keyOf(each)));
}
