import { useEffect, useRef, useState } from "react";
import { liveFeedUrl } from "../api";
import { LiveFeed, type LiveStatus, type SocketLike } from "../lib/liveFeed";

/**
 * Keep a repo's live feed open (its full name, "<owner>/<name>") and call
 * `onPing` when something changed. A null key closes it. Returns whether it's
 * connected, so pages can poll less while it is.
 */
export function useLiveFeed(key: string | null, onPing: () => void): LiveStatus {
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
			onPing: () => pingRef.current(),
			onStatus: setStatus,
		});
		feed.start();
		return () => feed.stop();
	}, [key]);
	return status;
}
