import type { Connection } from "../api";

// After someone copies the command that connects an agent, the Agents page looks for the new connection every few
// seconds for a while (connections otherwise refresh once a minute), and says so as soon as it's there.

export const WATCH_EVERY_MS = 3_000;
export const WATCH_FOR_MS = 120_000;

/** A watch under way: when it began, and the connections there were then. */
export interface Watch {
	startedAt: number;
	before: ReadonlySet<string>;
}

export type WatchStep = { kind: "found"; connection: Connection } | { kind: "waiting" } | { kind: "gave-up" };

/**
 * What one look at the connections finds: one that wasn't there when the watch began (and the watch stops), nothing
 * yet, or, two minutes on, nothing at all (and it stops).
 */
export function watchStep(watch: Watch, now: number, connections: Connection[]): WatchStep {
	const connection = connections.find((each) => !watch.before.has(each.id));
	if (connection) return { kind: "found", connection };
	return now - watch.startedAt >= WATCH_FOR_MS ? { kind: "gave-up" } : { kind: "waiting" };
}
