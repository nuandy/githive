import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../lib/errors";

export interface Poll<T> {
	data: T | undefined;
	error: string | undefined;
	/** A first answer (data or error) has arrived for the current key. */
	loaded: boolean;
	/** Fetch again now, e.g. after an action. */
	refresh(): void;
}

export interface PollScheduler {
	setInterval(callback: () => void, milliseconds: number): unknown;
	clearInterval(timer: unknown): void;
}

const browserScheduler: PollScheduler = {
	setInterval: (callback, ms) => window.setInterval(callback, ms),
	clearInterval: (timer) => window.clearInterval(timer as number),
};

/**
 * Fetch `key`'s data now and every `intervalMs` after, keeping the last good data
 * while a refresh runs or fails, so the page never flashes back to "loading".
 * A null key pauses polling. Requests never overlap, and a hidden tab skips
 * its ticks.
 */
export function usePoll<T>(
	key: string | null,
	fetcher: () => Promise<T>,
	intervalMs: number,
	scheduler: PollScheduler = browserScheduler,
): Poll<T> {
	const [state, setState] = useState<{ key: string | null; data?: T; error?: string; loaded: boolean }>({
		key: null,
		loaded: false,
	});
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const runRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		if (key === null) return;
		let active = true;
		let inFlight = false;
		const run = async (force = false) => {
			if (inFlight) return;
			if (!force && typeof document !== "undefined" && document.hidden) return;
			inFlight = true;
			try {
				const data = await fetcherRef.current();
				if (active) setState({ key, data, loaded: true });
			} catch (error) {
				const message = messageOf(error);
				// Keep the last good data for this key, so a failed refresh doesn't blank the page.
				const keepFor = (current: typeof state) => (current.key === key ? current : {});
				if (active) setState((current) => ({ ...keepFor(current), key, error: message, loaded: true }));
			} finally {
				inFlight = false;
			}
		};
		runRef.current = () => void run(true);
		void run(true);
		const timer = scheduler.setInterval(() => void run(), intervalMs);
		return () => {
			active = false;
			scheduler.clearInterval(timer);
		};
	}, [key, intervalMs, scheduler]);

	const refresh = useCallback(() => runRef.current(), []);
	const current = state.key === key ? state : undefined;
	return { data: current?.data, error: current?.error, loaded: !!current?.loaded, refresh };
}
