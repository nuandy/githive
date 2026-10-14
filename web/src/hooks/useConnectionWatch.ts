import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "../api";
import { WATCH_EVERY_MS, WATCH_FOR_MS, type WatchStep, watchStep } from "../lib/connectWatch";

export type WatchState = { kind: "idle" } | WatchStep;

/**
 * Looks for a new connection every 3 seconds for 2 minutes once `start` is called (as the command that makes one is
 * copied), and stops as one comes. Starting again begins again, from the connections there are then.
 */
export function useConnectionWatch(
	load: (() => Promise<Connection[]>) | undefined,
	/** The connections the page knows of: there before the watch began. */
	known: Connection[] | undefined,
	/** A new one came: the page reads its connections again. */
	onFound?: () => void,
) {
	const [state, setState] = useState<WatchState>({ kind: "idle" });
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	// Each watch's number: a look that belongs to an older one does nothing.
	const current = useRef(0);
	const latest = useRef({ load, known, onFound });
	latest.current = { load, known, onFound };
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			current.current++;
		},
		[],
	);

	const start = useCallback(async () => {
		const { load: read, known: there } = latest.current;
		if (!read) return;
		clearTimeout(timer.current);
		const id = ++current.current;
		const before = new Set((there ?? (await read().catch(() => []))).map((connection) => connection.id));
		const watch = { startedAt: Date.now(), before };
		setState({ kind: "waiting" });
		const look = async () => {
			const connections = await read().catch(() => null);
			if (id !== current.current) return;
			// A look that fails counts as one that found nothing.
			const step: WatchStep = connections
				? watchStep(watch, Date.now(), connections)
				: Date.now() - watch.startedAt >= WATCH_FOR_MS
					? { kind: "gave-up" }
					: { kind: "waiting" };
			if (step.kind === "waiting") {
				timer.current = setTimeout(look, WATCH_EVERY_MS);
				return;
			}
			setState(step);
			if (step.kind === "found") latest.current.onFound?.();
		};
		timer.current = setTimeout(look, WATCH_EVERY_MS);
	}, []);

	return { state, start };
}
