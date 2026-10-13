import { describe, expect, it } from "vitest";
import { backoffDelay, LiveFeed, type LiveStatus, type SocketLike, type Timers } from "./liveFeed";

class FakeSocket implements SocketLike {
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	closed = false;
	constructor(readonly url: string) {}
	close() {
		this.closed = true;
	}
}

/** Timers that run only when told, so reconnects and debouncing can be stepped through. */
class FakeTimers implements Timers {
	now = 0;
	private queue: { at: number; callback: () => void; id: number }[] = [];
	private next = 1;
	setTimeout(callback: () => void, ms: number) {
		const id = this.next++;
		this.queue.push({ at: this.now + ms, callback, id });
		return id;
	}
	clearTimeout(timer: unknown) {
		this.queue = this.queue.filter((t) => t.id !== timer);
	}
	advance(ms: number) {
		const until = this.now + ms;
		for (;;) {
			this.queue.sort((a, b) => a.at - b.at);
			const due = this.queue[0];
			if (!due || due.at > until) break;
			this.queue.shift();
			this.now = due.at;
			due.callback();
		}
		this.now = until;
	}
}

function setup() {
	const sockets: FakeSocket[] = [];
	const statuses: LiveStatus[] = [];
	let pings = 0;
	const kinds: string[][] = [];
	const events: unknown[][] = [];
	const timers = new FakeTimers();
	const feed = new LiveFeed({
		url: "wss://example.test/live/task:abcd1234",
		connect: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		onPing: (said) => {
			pings++;
			kinds.push(said);
		},
		onEvents: (brought) => events.push(brought),
		onStatus: (status) => statuses.push(status),
		timers,
		debounceMs: 200,
	});
	return { feed, sockets, statuses, timers, pings: () => pings, kinds, events };
}

describe("the live feed", () => {
	it("connects, and folds a burst of pings into one refresh", () => {
		const { feed, sockets, statuses, timers, pings } = setup();
		feed.start();
		expect(sockets[0]!.url).toBe("wss://example.test/live/task:abcd1234");
		expect(statuses).toEqual(["connecting"]);
		sockets[0]!.onopen?.({});
		expect(statuses.at(-1)).toBe("live");
		expect(pings()).toBe(0);
		sockets[0]!.onmessage?.({});
		sockets[0]!.onmessage?.({});
		sockets[0]!.onmessage?.({});
		timers.advance(199);
		expect(pings()).toBe(0);
		timers.advance(1);
		expect(pings()).toBe(1);
	});

	it("reconnects with growing delays, and refreshes once it is back", () => {
		const { feed, sockets, statuses, timers, pings } = setup();
		feed.start();
		sockets[0]!.onclose?.({});
		expect(statuses.at(-1)).toBe("reconnecting");
		timers.advance(999);
		expect(sockets).toHaveLength(1);
		timers.advance(1);
		expect(sockets).toHaveLength(2);
		sockets[1]!.onclose?.({});
		timers.advance(1_999);
		expect(sockets).toHaveLength(2);
		timers.advance(1);
		expect(sockets).toHaveLength(3);
		sockets[2]!.onopen?.({});
		expect(statuses.at(-1)).toBe("live");
		// It had been down: anything may have changed. (The first connection doesn't count as "back".)
		timers.advance(200);
		expect(pings()).toBe(0);
		sockets[2]!.onclose?.({});
		timers.advance(1_000);
		sockets[3]!.onopen?.({});
		timers.advance(200);
		expect(pings()).toBe(1);
	});

	it("stops cleanly: closes the socket, cancels the retry, and ignores late events", () => {
		const { feed, sockets, statuses, timers, pings } = setup();
		feed.start();
		sockets[0]!.onclose?.({});
		feed.stop();
		expect(statuses.at(-1)).toBe("off");
		timers.advance(60_000);
		expect(sockets).toHaveLength(1);
		feed.start();
		feed.stop();
		expect(sockets[1]!.closed).toBe(true);
		sockets[1]!.onmessage?.({});
		timers.advance(1_000);
		expect(pings()).toBe(0);
	});

	it("says which kinds changed in a burst, and passes each message's events on as it comes", () => {
		const { feed, sockets, timers, kinds, events } = setup();
		feed.start();
		sockets[0]!.onopen?.({});
		const event = { kind: "claimed", agent: "bee", at: "2026-10-13T10:00:00.000Z" };
		const send = (message: object) => sockets[0]!.onmessage?.({ data: JSON.stringify(message) });
		send({ seq: 1, kind: "records", at: event.at, events: [event] });
		send({ seq: 2, kind: "awareness", at: event.at });
		send({ seq: 3, kind: "records", at: event.at });
		expect(events).toEqual([[event]]);
		timers.advance(200);
		expect(kinds).toEqual([["records", "awareness"]]);
	});

	it("reconnects with the last message's number, and leaves what was missed to the server", () => {
		const { feed, sockets, timers, pings } = setup();
		feed.start();
		sockets[0]!.onopen?.({});
		sockets[0]!.onmessage?.({ data: JSON.stringify({ seq: 41, kind: "records", at: "now" }) });
		timers.advance(200);
		expect(pings()).toBe(1);
		sockets[0]!.onclose?.({});
		timers.advance(1_000);
		expect(sockets[1]!.url).toBe("wss://example.test/live/task:abcd1234?since=41");
		sockets[1]!.onopen?.({});
		timers.advance(200);
		// The server sends what was missed, or "missed": the page doesn't read everything again on its own.
		expect(pings()).toBe(1);
	});

	it("caps the backoff", () => {
		expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n))).toEqual([1_000, 2_000, 4_000, 8_000, 30_000]);
	});
});
