// A repo's live feed: a WebSocket on which each message only means "something
// changed, read again". This keeps the socket open, reconnects with backoff,
// and folds bursts of pings into one refresh. No React here, so it can be
// tested with a fake socket and fake timers.

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
	/** Read everything again. */
	onPing(): void;
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
			socket = this.options.connect(this.options.url);
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
			// Anything may have changed while the socket was down.
			if (reopened) this.ping();
		};
		socket.onmessage = () => {
			if (!this.stopped && this.socket === socket) this.ping();
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

	private ping() {
		if (this.pingTimer !== null) return;
		this.pingTimer = this.timers.setTimeout(() => {
			this.pingTimer = null;
			if (!this.stopped) this.options.onPing();
		}, this.options.debounceMs ?? 250);
	}
}
