import { useEffect, useState } from "react";
import type { HiveEvent } from "../api";
import { listenForLiveEvents } from "../lib/liveEvents";

/** The most events kept from the live feed: as many as the server's feed keeps. */
const KEPT = 100;

/** The hive events `repo`'s live feed has brought since the page opened, oldest first. */
export function useLiveEvents(repo: string): HiveEvent[] {
	const [events, setEvents] = useState<HiveEvent[]>([]);
	useEffect(() => {
		setEvents([]);
		return listenForLiveEvents(repo, (brought) =>
			setEvents((kept) => [...kept, ...(brought as HiveEvent[])].slice(-KEPT)),
		);
	}, [repo]);
	return events;
}
