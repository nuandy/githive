import { useEffect, useRef, useState } from "react";
import { liveFeedUrl } from "../api";
import { tellLiveEvents, tellLiveStatus } from "../lib/liveEvents";
import { type Latest, LiveFeed, type LiveStatus, type SocketLike } from "../lib/liveFeed";

/**
 * Keep a repo's live feed open (its full name, "<owner>/<name>") and call
 * `onPing` with the kinds of change since the last call, and where the feed is. The events messages
 * carry go to the page's listeners (see liveEvents.ts). A null key closes it.
 * Returns whether it's connected, so pages can poll less while it is.
 */
export function useLiveFeed(key: string | null, onPing: (kinds: string[], latest: Latest) => void): LiveStatus {
	const [status, setStatus] = useState<LiveStatus>("off");
	const pingRef = useRef(onPing);
	pingRef.current = onPing;
	useEffect(() => {
		if (key === null || typeof WebSocket === "undefined") {
			setStatus("off");
			return;
		}
		const feed = new LiveFeed({
			url: liveFeedUrl(key),
			connect: (url) => new WebSocket(url) as unknown as SocketLike,
			onPing: (kinds, latest) => pingRef.current(kinds, latest),
			onEvents: (events) => tellLiveEvents(key, events),
			onStatus: (status) => {
				tellLiveStatus(key, status === "live");
				setStatus(status);
			},
		});
		feed.start();
		return () => feed.stop();
	}, [key]);
	return status;
}
