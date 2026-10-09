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


/** A record's tip as kept: where its ref points (null: nowhere) and when that was known, its generation, and when a listing began. */
interface KeptTip {
	tip?: string | null;
	at?: number;
	gen: number;
	listing?: number;
}

/** How long one caller's listing of a ref stands before another is sent. */
const TIP_LISTING_MS = 3_000;

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

	/** A record's state at `tip`, if a reader kept it (see record-log.ts StateCache). */
	async recordAt(ref: string, tip: string) {
		const kept = await this.ctx.storage.get<{ tip: string; json: string }>(`record:${ref}`);
		return kept?.tip === tip ? kept.json : undefined;
	}

	/** Keep a record's state at `tip`, its latest: a newer tip replaces it. */
	async keepRecord(ref: string, tip: string, json: string) {
		if (json.length > 1_000_000) return;
		await this.ctx.storage.put(`record:${ref}`, { tip, json });
	}

	/**
	 * Where a record's ref points, as kept (see TipCache in record-log.ts),
	 * with its state when kept for that tip, and the generation a listing is
	 * kept under. One caller at a time is sent to list the ref: when nothing
	 * is kept (the others are told to wait for it), or when what's kept is
	 * older than `maxAgeMs` (the others take it meanwhile: a write would have
	 * moved it, so it only ages in case one couldn't).
	 */
	async tipOf(ref: string, stateKey: string, maxAgeMs: number): Promise<{ tip?: string | null; json?: string; gen: number; wait?: boolean }> {
		const key = `tip:${ref}`;
		const kept = (await this.ctx.storage.get<KeptTip>(key)) ?? { gen: 0 };
		const now = Date.now();
		const listing = kept.listing !== undefined && now - kept.listing < TIP_LISTING_MS;
		if (kept.tip === undefined || now - (kept.at ?? 0) > maxAgeMs) {
			if (!listing) {
				await this.ctx.storage.put(key, { ...kept, listing: now });
				return { gen: kept.gen };
			}
			if (kept.tip === undefined) return { gen: kept.gen, wait: true };
		}
		const state = kept.tip ? await this.ctx.storage.get<{ tip: string; json: string }>(`record:${stateKey}`) : undefined;
		return { tip: kept.tip, gen: kept.gen, ...(state?.tip === kept.tip ? { json: state.json } : {}) };
	}

	/** Keep a listing of a record's ref, unless it moved since the listing began (its generation is past `gen`). */
	async keepTip(ref: string, tip: string | null, gen: number) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if ((kept?.gen ?? 0) === gen) await this.ctx.storage.put(`tip:${ref}`, { tip, at: Date.now(), gen });
	}

	/**
	 * A write moved a record's ref from `parent` to `tip`. Kept as the tip if
	 * the kept one is its parent; otherwise writes are arriving out of order
	 * (or one was lost), and the tip is forgotten until it's listed again.
	 * Either way a listing under way is dropped.
	 */
	async landedTip(ref: string, parent: string | null, tip: string) {
		const kept = (await this.ctx.storage.get<KeptTip>(`tip:${ref}`)) ?? { gen: 0 };
		const gen = kept.gen + 1;
		await this.ctx.storage.put(`tip:${ref}`, kept.tip === parent ? { tip, at: Date.now(), gen } : { gen });
	}

	/** A write built on `parent` found the ref had moved on: if that's the tip kept, it's out of date. */
	async staleTip(ref: string, parent: string | null) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if (kept && kept.tip === parent) await this.ctx.storage.put(`tip:${ref}`, { gen: kept.gen + 1 });
	}

	/** Forget the kept views: the repo was deleted. */
	async clearViews() {
		const kept = await this.ctx.storage.list({ prefix: "view:" });
		const building = await this.ctx.storage.list({ prefix: "building:" });
		const records = await this.ctx.storage.list({ prefix: "record:" });
		const tips = await this.ctx.storage.list({ prefix: "tip:" });
		await this.ctx.storage.delete([...kept.keys(), ...building.keys(), ...records.keys(), ...tips.keys()]);
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
