// The hive events a repo's live feed brings (see liveFeed.ts), for the parts of a page that show them: the feed
// holds the socket, and anything on the page may listen for a repo's events. No React here.

type Listener = (events: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const connected = new Set<string>();

/** Notes whether `repo`'s feed is connected, so a listener knows whether to count on it. */
export function tellLiveStatus(repo: string, live: boolean) {
	if (live) connected.add(repo);
	else connected.delete(repo);
}

/** Whether `repo`'s feed is connected now. */
export const isLive = (repo: string) => connected.has(repo);

/** Tells everyone listening for `repo` of the events its feed just brought. */
export function tellLiveEvents(repo: string, events: unknown[]) {
	for (const listener of listeners.get(repo) ?? []) listener(events);
}

/** Listens for `repo`'s live events, until the returned function is called. */
export function listenForLiveEvents(repo: string, listener: Listener) {
	const forRepo = listeners.get(repo) ?? new Set<Listener>();
	forRepo.add(listener);
	listeners.set(repo, forRepo);
	return () => {
		forRepo.delete(listener);
		if (!forRepo.size) listeners.delete(repo);
	};
}
