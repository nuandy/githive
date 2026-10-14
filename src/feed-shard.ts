import { DurableObject } from "cloudflare:workers";
import { rpc } from "./rpc";

// A share of the pages watching a repo ("feed:<repo>:<n>"). However many people watch, the repo's RepoCache sends each
// message once per shard rather than once per page, and pages never wait in line with agents' calls. RepoCache numbers
// and keeps the messages (page-feed.ts) and knows how many pages each shard holds; a shard only holds sockets.

/** How many pages a shard takes before the next one opens. */
export const PAGES_PER_SHARD = 250;

/** The repo whose feed a shard is, and its name, as the route that opens a page's feed tells it. */
const FEED_REPO = "X-GitHive-Feed-Repo";
const FEED_SHARD = "X-GitHive-Feed-Shard";

/** The name of a repo's `shard`th feed object. */
export const feedShardName = (repo: string, shard: number) => `feed:${repo}:${shard}`;

/**
 * Opens a page's live feed on `repo`, in the shard its RepoCache says has room. The caller has already checked that
 * the reader may read the repo.
 */
export async function openFeed(env: Env, repo: string, request: Request) {
	if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
	const shard = await rpc(env.REPO_CACHE.getByName(`repo:${repo}`).feedShardFor(repo));
	const headers = new Headers(request.headers);
	headers.set(FEED_REPO, repo);
	headers.set(FEED_SHARD, String(shard));
	return env.FEED_SHARD.getByName(feedShardName(repo, shard)).fetch(new Request(request, { headers }));
}

interface Identity {
	repo: string;
	shard: number;
}

export class FeedShard extends DurableObject<Env> {
	/**
	 * A page's socket. A page that reconnects with `?since=<seq>`, the last message it had, is first sent what it
	 * missed.
	 */
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const identity = await this.identityFrom(request);
		if (!identity) return new Response("open a feed through its repo", { status: 400 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const since = Number(new URL(request.url).searchParams.get("since") ?? "");
		const cache = this.env.REPO_CACHE.getByName(`repo:${identity.repo}`);
		if (Number.isInteger(since) && since >= 0)
			for (const message of await rpc(cache.pagesSince(since))) server.send(JSON.stringify(message));
		await this.report(identity);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Sends `message` to every page here, and returns how many are still open. */
	async send(message: string) {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				// The page went away; the runtime closes the socket.
			}
		}
		return this.openPages();
	}

	// Pages only listen; anything they send is ignored.
	async webSocketMessage() {}

	async webSocketClose(socket: WebSocket, code: number) {
		socket.close(code === 1005 ? 1000 : code, "closed");
		const identity = await this.ctx.storage.get<Identity>("identity");
		if (identity) await this.report(identity);
	}

	// The shard learns which it is from the route that opened it, and keeps that for when it wakes without one.
	private async identityFrom(request: Request): Promise<Identity | null> {
		const repo = request.headers.get(FEED_REPO);
		const shard = Number(request.headers.get(FEED_SHARD));
		if (!repo || !Number.isInteger(shard)) return null;
		const identity = { repo, shard };
		await this.ctx.storage.put("identity", identity);
		return identity;
	}

	private openPages() {
		return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN).length;
	}

	// Tells the repo's cache how many pages are here, so it sends only to shards someone is watching.
	private async report({ repo, shard }: Identity) {
		const pages = this.openPages();
		await rpc(this.env.REPO_CACHE.getByName(`repo:${repo}`).feedPages(shard, pages)).catch((err: unknown) =>
			console.error(`telling repo:${repo} its feed shard ${shard} has ${pages} pages failed`, String(err)),
		);
	}
}
