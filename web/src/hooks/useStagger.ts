import { useEffect, useState } from "react";

/** How long a stagger takes: nine steps of --stagger-step (35ms), then the last row's own fade, and a little to spare. */
const STAGGER_MS = 9 * 35 + 250 + 100;

/**
 * Whether a list's rows should come in one after another now (the stagger utility): from the moment it has rows, for
 * as long as that takes. A list that's slow to load staggers when its rows come, not before; rows that come later
 * (a poll, a new arrival) don't, and come in on their own (useArrivals).
 */
export function useStagger(ready: boolean): boolean {
	const [started, setStarted] = useState(ready);
	const [done, setDone] = useState(false);
	if (ready && !started) setStarted(true);
	useEffect(() => {
		if (!started) return;
		const timer = setTimeout(() => setDone(true), STAGGER_MS);
		return () => clearTimeout(timer);
	}, [started]);
	return started && !done;
}
