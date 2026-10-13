import type { HiveEvent } from "../api";

/** The most events the hive's feed shows: as many as the server keeps. */
const SHOWN = 100;

// An event's identity: the live feed and a read of the feed can bring the same one.
const keyOf = (event: HiveEvent) =>
	[event.at, event.kind, event.agent, event.change, event.commit, event.other, event.otherChange].join("|");

/** The events read with those the live feed brought since, each once, oldest first. */
export function mergeEvents(read: HiveEvent[], live: HiveEvent[]): HiveEvent[] {
	const byKey = new Map<string, HiveEvent>();
	for (const event of [...read, ...live]) byKey.set(keyOf(event), event);
	return [...byKey.values()].sort((one, other) => one.at.localeCompare(other.at)).slice(-SHOWN);
}
