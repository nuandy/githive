import { useCallback, useRef, useState } from "react";

/** How often a live region may speak: a screen reader hears at most one announcement every few seconds. */
export const SAY_EVERY_MS = 4_000;

/** Whether a live region that last spoke at `last` may speak again at `now`. */
export const mayAnnounce = (last: number, now: number, everyMs = SAY_EVERY_MS) => now - last >= everyMs;

/**
 * What a page says to a screen reader as things change under it, however busy it gets: `say` what happened, and draw
 * `<Announcer said={said} />` (components/ui/announcer.tsx) once on the page. It speaks at most once every `everyMs`;
 * what's said before then is dropped, not queued, since by then something newer will be worth saying.
 */
export function useAnnouncer(everyMs = SAY_EVERY_MS) {
	const [said, setSaid] = useState("");
	const last = useRef(0);
	const say = useCallback(
		(words: string) => {
			if (!words || !mayAnnounce(last.current, Date.now(), everyMs)) return;
			last.current = Date.now();
			setSaid(words);
		},
		[everyMs],
	);
	return { said, say };
}
