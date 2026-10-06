import { DurableObject } from "cloudflare:workers";

// One per repo ("task:<id>" or "free:<repo>"), for the dashboard:
//
// Live updates. Pages hold a WebSocket open; whoever decides something there
// (an elected leader after each commit, the coordinator-free toolkit after a
// write) pings the feed, and every page refreshes at once instead of waiting
// for its next poll. Sockets hibernate between pings, so an idle feed costs
// nothing. A ping carries no data, only that something changed: pages read
// the state through the usual routes, with the reader's own access.
//
// Ready-made views. Reading a coordinator-free repo from Git takes many round
// trips (its snapshot ~9 s, its audit ~20 s), so the last of each view is kept
// here, with the count of writes it was built after. A write makes it stale;
// a stale view is still served at once while a fresh one is built in the
// background (one at a time), and pages are told when it's ready. Views also
// age out, for what reaches Git without a ping. Git stays the truth: a view
// is only a copy of what was read from it.

interface View {
	/** The view as JSON, as served. */
	json: string;
	/** The count of writes when it was built. */
	writes: number;
	at: number;
}

/** How long a build may run before another caller may start one. */
const BUILD_LEASE_MS = 2 * 60_000;

export class LiveFeed extends DurableObject<Env> {
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Tell every page watching that something changed; a write (the default) also makes the views stale. */
	async ping(kind: string, write = true) {
		if (write) await this.ctx.storage.put("writes", (await this.writes()) + 1);
		this.broadcast(kind);
	}

	/** The kept view `name`: its JSON, whether it's still fresh, whether a build is running, and the write count now. */
	async view(name: string, maxAgeMs: number) {
		const [writes, kept, building] = await Promise.all([this.writes(), this.ctx.storage.get<View>(`view:${name}`), this.ctx.storage.get<number>(`building:${name}`)]);
		return {
			json: kept?.json,
			fresh: !!kept && kept.writes === writes && Date.now() - kept.at < maxAgeMs,
			building: !!building && Date.now() - building < BUILD_LEASE_MS,
			writes,
		};
	}

	/** Take the build of `name`, unless another is running: true if this caller should build it. */
	async startBuild(name: string) {
		const building = await this.ctx.storage.get<number>(`building:${name}`);
		if (building && Date.now() - building < BUILD_LEASE_MS) return false;
		await this.ctx.storage.put(`building:${name}`, Date.now());
		return true;
	}

	/** Keep a built view (built after `writes` writes) and tell pages it's ready. */
	async keep(name: string, json: string, writes: number) {
		await this.ctx.storage.put<View>(`view:${name}`, { json, writes, at: Date.now() });
		await this.ctx.storage.delete(`building:${name}`);
		this.broadcast(`view:${name}`);
	}

	/** A build that failed: let the next caller try. */
	async buildFailed(name: string) {
		await this.ctx.storage.delete(`building:${name}`);
	}

	private async writes() {
		return (await this.ctx.storage.get<number>("writes")) ?? 0;
	}

	private broadcast(kind: string) {
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
