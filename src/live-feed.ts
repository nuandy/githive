import { DurableObject } from "cloudflare:workers";

// Live updates for the dashboard: one feed per repo ("task:<id>" or
// "free:<repo>"). Pages hold a WebSocket open; whoever decides something there
// (an elected leader after each commit, the coordinator-free toolkit after a
// write) pings the feed, and every page refreshes at once instead of waiting
// for its next poll. Sockets hibernate between pings, so an idle feed costs
// nothing. A ping carries no data, only that something changed: pages read
// the state through the usual routes, with the reader's own access.

export class LiveFeed extends DurableObject<Env> {
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Tell every page watching that something changed. */
	async ping(kind: string) {
		const message = JSON.stringify({ kind, at: new Date().toISOString() });
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				// A page that went away; the runtime closes it.
			}
		}
	}

	// Pages only listen; anything they send is ignored.
	async webSocketMessage() {}

	async webSocketClose(socket: WebSocket, code: number) {
		socket.close(code === 1005 ? 1000 : code, "closed");
	}
}
