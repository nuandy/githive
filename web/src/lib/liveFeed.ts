// A repo's live feed: a WebSocket on which each message says what changed (its
// kind, so a page reads again only what that touches) and carries the events
// that came with it, so the hive's feed shows them without reading again. Each
// message has a number: a reconnect says the last one had, and the server sends
// what was missed, or "missed" when that's too much. This keeps the socket open,
// reconnects with backoff, and folds bursts of messages into one refresh. No
// React here, so it can be tested with a fake socket and fake timers.

export type LiveStatus = "off" | "connecting" | "live" | "reconnecting";

export interface SocketLike {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(): void;
}

export interface Timers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface LiveFeedOptions {
	url: string;
	connect: (url: string) => SocketLike;
	/**
	 * Read again what these kinds of change touch: "records", "pushed", "landing", "awareness", "view:<name>", or
	 * "missed" (read everything). A message from an older server, without a kind, comes as "missed".
	 */
	onPing(kinds: string[]): void;
	/** The hive events a message carried, as it arrives. */
	onEvents?(events: unknown[]): void;
	onStatus(status: LiveStatus): void;
	timers?: Timers;
	/** Pings closer together than this make one refresh. */
	debounceMs?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
}

/** 1s, 2s, 4s, … up to the cap. */
export function backoffDelay(attempt: number, minMs = 1_000, maxMs = 30_000): number {
	return Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
}

const defaultTimers: Timers = {
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class LiveFeed {
	private socket: SocketLike | null = null;
	private attempt = 0;
	private stopped = true;
	private reconnectTimer: unknown = null;
	private pingTimer: unknown = null;
	private everOpened = false;
	/** The number of the last message had, once a server that numbers them has sent one. */
	private lastSeq: number | null = null;
	private readonly kinds = new Set<string>();
	private readonly timers: Timers;

	constructor(private readonly options: LiveFeedOptions) {
		this.timers = options.timers ?? defaultTimers;
	}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.open();
	}

	stop() {
		this.stopped = true;
		if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
		if (this.pingTimer !== null) this.timers.clearTimeout(this.pingTimer);
		this.reconnectTimer = this.pingTimer = null;
		this.kinds.clear();
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
			try {
				socket.close();
			} catch {
				// Already closed.
			}
		}
		this.options.onStatus("off");
	}

	private open() {
		this.options.onStatus(this.everOpened || this.attempt > 0 ? "reconnecting" : "connecting");
		let socket: SocketLike;
		try {
			socket = this.options.connect(this.urlFromLast());
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (this.stopped || this.socket !== socket) return;
			const reopened = this.everOpened;
			this.everOpened = true;
			this.attempt = 0;
			this.options.onStatus("live");
			// Anything may have changed while the socket was down. A server that numbers its messages sends what was
			// missed; one that doesn't can't, so everything is read again.
			if (reopened && this.lastSeq === null) this.ping("missed");
		};
		socket.onmessage = (event) => {
			if (!this.stopped && this.socket === socket) this.received(event);
		};
		socket.onclose = () => {
			if (this.stopped || this.socket !== socket) return;
			this.socket = null;
			this.scheduleReconnect();
		};
		socket.onerror = () => undefined;
	}

	private scheduleReconnect() {
		if (this.stopped) return;
		this.options.onStatus("reconnecting");
		const delay = backoffDelay(this.attempt++, this.options.minDelayMs, this.options.maxDelayMs);
		this.reconnectTimer = this.timers.setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) this.open();
		}, delay);
	}

	private urlFromLast() {
		if (this.lastSeq === null) return this.options.url;
		const joiner = this.options.url.includes("?") ? "&" : "?";
		return `${this.options.url}${joiner}since=${this.lastSeq}`;
	}

	private received(event: unknown) {
		const message = messageOf(event);
		if (message.seq !== undefined) this.lastSeq = message.seq;
		if (message.events?.length) this.options.onEvents?.(message.events);
		this.ping(message.kind);
	}

	private ping(kind: string) {
		this.kinds.add(kind);
		if (this.pingTimer !== null) return;
		this.pingTimer = this.timers.setTimeout(() => {
			this.pingTimer = null;
			const kinds = [...this.kinds];
			this.kinds.clear();
			if (!this.stopped) this.options.onPing(kinds);
		}, this.options.debounceMs ?? 250);
	}
}

interface Message {
	kind: string;
	seq?: number;
	events?: unknown[];
}

// A message as the server sends it. Anything else, from an older server, means only "something changed".
function messageOf(event: unknown): Message {
	const data = (event as { data?: unknown } | null)?.data;
	let parsed: unknown;
	try {
		parsed = typeof data === "string" ? JSON.parse(data) : undefined;
	} catch {
		parsed = undefined;
	}
	const message = (parsed ?? {}) as Partial<Message>;
	if (typeof message.kind !== "string") return { kind: "missed" };
	return {
		kind: message.kind,
		...(typeof message.seq === "number" ? { seq: message.seq } : {}),
		...(Array.isArray(message.events) ? { events: message.events } : {}),
	};
}
