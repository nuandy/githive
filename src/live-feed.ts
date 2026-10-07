import { DurableObject } from "cloudflare:workers";

// One per repo ("repo:<repo>"), for the dashboard:
//
// Live updates. Pages hold a WebSocket open; the toolkit pings the feed after
// each write, and every page refreshes at once instead of waiting
// for its next poll. Sockets hibernate between pings, so an idle feed costs
// nothing. A ping carries no data, only that something changed: pages read
// the state through the usual routes, with the reader's own access.
//
// Ready-made views. Reading a repo from Git takes many round
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

/**
 * Review holds, for next: which agents are
 * reviewing a commit in a role (keyed as toolkit/work.ts holdKey), until they
 * vote or the hold runs out. A hint so two
 * agents aren't sent to the same review that needs one; not a record.
 */
type Holds = Record<string, Record<string, number>>;
/** How long a review hold lasts if its agent never votes. */
export const REVIEW_HOLD_MS = 15 * 60_000;
/**
 * How long a hold lasts once its agent voted: a vote just written can take a
 * moment to show in every read of the votes, and until it does, the change
 * would look unreviewed (and unheld) to the next agent asking.
 */
export const VOTED_HOLD_MS = 60_000;

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

	/** Forget the kept views: the repo was deleted. */
	async clearViews() {
		const kept = await this.ctx.storage.list({ prefix: "view:" });
		const building = await this.ctx.storage.list({ prefix: "building:" });
		await this.ctx.storage.delete([...kept.keys(), ...building.keys()]);
	}

	/** The review holds in force: by commit, the agents reviewing it. */
	async reviewsHeld(): Promise<Record<string, string[]>> {
		const holds = this.live((await this.ctx.storage.get<Holds>("holds")) ?? {});
		return Object.fromEntries(Object.entries(holds).map(([head, agents]) => [head, Object.keys(agents)]));
	}

	/**
	 * Hold a review of `head` for `agent`, if fewer than `needed` others hold
	 * one. Atomic: two agents asking at once can't both take the last one.
	 */
	async holdReview(head: string, agent: string, needed: number) {
		const holds = this.live((await this.ctx.storage.get<Holds>("holds")) ?? {});
		const others = Object.keys(holds[head] ?? {}).filter((a) => a !== agent);
		if (others.length >= needed) return false;
		holds[head] = { ...holds[head], [agent]: Date.now() + REVIEW_HOLD_MS };
		await this.ctx.storage.put("holds", holds);
		return true;
	}

	/** The agent voted on `head`: its hold goes once the vote has had a moment to show everywhere. */
	async releaseReview(head: string, agent: string) {
		const holds = this.live((await this.ctx.storage.get<Holds>("holds")) ?? {});
		if (!holds[head]?.[agent]) return;
		holds[head][agent] = Math.min(holds[head][agent], Date.now() + VOTED_HOLD_MS);
		await this.ctx.storage.put("holds", holds);
	}

	/**
	 * When each of `waiting` (reviews a role that can block awaits, by
	 * holdKey) was first seen waiting, and whether people were told. Reviews
	 * no longer waiting are forgotten, so a review that waits again starts over.
	 */
	async roleWaits(waiting: string[]): Promise<Record<string, { since: number; told?: boolean }>> {
		const known = (await this.ctx.storage.get<Record<string, { since: number; told?: boolean }>>("roleWaits")) ?? {};
		const now = Date.now();
		const current = Object.fromEntries(waiting.map((key) => [key, known[key] ?? { since: now }]));
		await this.ctx.storage.put("roleWaits", current);
		return current;
	}

	/** People were told about a waiting review: once is enough. */
	async roleWaitTold(key: string) {
		const known = (await this.ctx.storage.get<Record<string, { since: number; told?: boolean }>>("roleWaits")) ?? {};
		if (!known[key]) return;
		known[key].told = true;
		await this.ctx.storage.put("roleWaits", known);
	}

	/** The holds that haven't run out. */
	private live(holds: Holds): Holds {
		const now = Date.now();
		const kept: Holds = {};
		for (const [head, agents] of Object.entries(holds)) {
			const alive = Object.fromEntries(Object.entries(agents).filter(([, until]) => until > now));
			if (Object.keys(alive).length) kept[head] = alive;
		}
		return kept;
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
