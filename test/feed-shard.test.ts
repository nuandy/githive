import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");
const { FeedShard, PAGES_PER_SHARD, feedShardName, openFeed } = await import("../src/feed-shard");
const { spreadFor } = await import("../src/page-feed");
const { keptView } = await import("../src/routes/kept-view");

// A repo's watching pages are spread over feed shards, so many viewers cost its RepoCache one send per shard, and
// pages reading again at the same feed number share one read of a view.

/** A repo cache whose feed shards answer with `pages` (or throw), recording what each was sent. */
function cacheWithShards(pages: (shard: string) => number = () => 1) {
	const sent = new Map<string, string[]>();
	const env = {
		FEED_SHARD: {
			getByName: (name: string) => ({
				send: async (message: string) => {
					sent.set(name, [...(sent.get(name) ?? []), JSON.parse(message).kind]);
					return pages(name);
				},
			}),
		},
	};
	const waiting: Promise<unknown>[] = [];
	const ctx = { storage: new FakeStorage(), waitUntil: (promise: Promise<unknown>) => waiting.push(promise) };
	const cache = new RepoCache(ctx as never, env as never);
	return { cache, sent, settled: () => Promise.all(waiting) };
}

describe("a repo's feed shards", () => {
	it("fill one at a time, a page counted as soon as it's given a shard", async () => {
		const { cache } = cacheWithShards();
		const shards = [];
		for (let page = 0; page < PAGES_PER_SHARD + 2; page++) shards.push(await cache.feedShardFor("acme--web"));
		expect(shards.filter((shard) => shard === 0)).toHaveLength(PAGES_PER_SHARD);
		expect(shards.slice(-2)).toEqual([1, 1]);
		// Pages that left free room in the first again.
		await cache.feedPages(0, 10);
		expect(await cache.feedShardFor("acme--web")).toBe(0);
	});

	it("are each sent a message once, however many pages they hold, and only while someone watches", async () => {
		const { cache, sent, settled } = cacheWithShards((shard) => (shard.endsWith(":1") ? 0 : 200));
		await cache.ping("records");
		expect(sent.size).toBe(0);
		await cache.feedShardFor("acme--web");
		await cache.feedPages(1, 3);
		await cache.ping("records");
		await settled();
		expect(sent).toEqual(
			new Map([
				[feedShardName("acme--web", 0), ["records"]],
				[feedShardName("acme--web", 1), ["records"]],
			]),
		);
		// Shard 1 said it has no pages left, so it isn't sent the next.
		await cache.ping("pushed", false);
		await settled();
		expect(sent.get(feedShardName("acme--web", 1))).toEqual(["records"]);
		expect(sent.get(feedShardName("acme--web", 0))).toEqual(["records", "pushed"]);
	});

	it("don't hold up a write when one fails, and keep its count to try again", async () => {
		let failing = true;
		const { cache, sent, settled } = cacheWithShards(() => {
			if (failing) throw new Error("reset");
			return 1;
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await cache.feedShardFor("acme--web");
		await cache.ping("records");
		await settled();
		failing = false;
		await cache.ping("records");
		await settled();
		expect(sent.get(feedShardName("acme--web", 0))).toEqual(["records", "records"]);
	});

	it("ask pages to spread their reads once many watch", async () => {
		expect(spreadFor(3)).toBe(0);
		expect(spreadFor(5_000)).toBe(1_000);
		expect(spreadFor(100_000)).toBe(2_000);
		const { cache } = cacheWithShards(() => 400);
		await cache.feedShardFor("acme--web");
		await cache.feedPages(0, 400);
		await cache.ping("records");
		expect(await cache.pagesSince(0)).toEqual([expect.objectContaining({ kind: "records", spreadMs: 80 })]);
	});
});

describe("a feed shard", () => {
	it("sends a message to each page it holds, and says how many are still open", async () => {
		const got: string[] = [];
		const socket = { send: (message: string) => got.push(message), readyState: 1 };
		const gone = {
			send: () => {
				throw new Error("closed");
			},
			readyState: 3,
		};
		const shard = new FeedShard(
			{ storage: new FakeStorage(), getWebSockets: () => [socket, gone] } as never,
			{} as never,
		);
		expect(await shard.send('{"kind":"records"}')).toBe(1);
		expect(got).toEqual(['{"kind":"records"}']);
	});

	it("takes only a WebSocket, opened through its repo", async () => {
		const shard = new FeedShard({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		expect((await shard.fetch(new Request("https://githive.test/live"))).status).toBe(426);
		const upgrade = new Request("https://githive.test/live", { headers: { Upgrade: "websocket" } });
		expect((await shard.fetch(upgrade)).status).toBe(400);
	});
});

describe("opening a page's feed", () => {
	it("joins the shard the repo's cache gives it, named for the repo", async () => {
		const opened: { name: string; repo: string | null; shard: string | null }[] = [];
		const env = {
			REPO_CACHE: { getByName: () => ({ feedShardFor: async () => 3 }) },
			FEED_SHARD: {
				getByName: (name: string) => ({
					fetch: async (request: Request) => {
						const repo = request.headers.get("X-GitHive-Feed-Repo");
						opened.push({ name, repo, shard: request.headers.get("X-GitHive-Feed-Shard") });
						return new Response("socket");
					},
				}),
			},
		};
		const upgrade = new Request("https://githive.test/repos/acme/web/live", { headers: { Upgrade: "websocket" } });
		expect(await (await openFeed(env as never, "acme--web", upgrade)).text()).toBe("socket");
		expect(opened).toEqual([{ name: "feed:acme--web:3", repo: "acme--web", shard: "3" }]);
		expect((await openFeed(env as never, "acme--web", new Request("https://githive.test/live"))).status).toBe(426);
	});
});

describe("views read at a feed number", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** A context for keptView: a request with `query` and `headers`, a repo cache that counts its reads. */
	function viewContext(query: Record<string, string>, headers: Record<string, string> = {}) {
		const reads = { count: 0 };
		const cache = {
			view: async () => {
				reads.count++;
				return { json: '{"open":1}', fresh: true, building: false, writes: 0 };
			},
			startBuild: async () => true,
			keep: async () => 1,
		};
		const waiting: Promise<unknown>[] = [];
		const c = {
			env: { REPO_CACHE: { getByName: () => cache } },
			req: {
				url: "https://githive.test/repos/acme/web",
				header: (name: string) => headers[name],
				query: (name: string) => query[name],
			},
			executionCtx: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
			body: (json: string, status: number) => new Response(json, { status }),
		};
		return { c, reads, settled: () => Promise.all(waiting) };
	}

	function stubCache() {
		const kept = new Map<string, Response>();
		vi.stubGlobal("caches", {
			default: {
				match: async (request: Request) => kept.get(request.url)?.clone(),
				put: async (request: Request, response: Response) => void kept.set(request.url, response),
			},
		});
		return kept;
	}

	const build = async () => ({ open: 1 });

	it("are read from the repo's cache once, and shared with every reader at that number", async () => {
		const kept = stubCache();
		const first = viewContext({ seq: "41" });
		expect(await (await keptView(first.c as never, "repo:acme--web", "snapshot", 20_000, build)).text()).toBe(
			'{"open":1}',
		);
		await first.settled();
		expect(kept.size).toBe(1);
		const second = viewContext({ seq: "41" });
		expect(await (await keptView(second.c as never, "repo:acme--web", "snapshot", 20_000, build)).text()).toBe(
			'{"open":1}',
		);
		expect(second.reads.count).toBe(0);
		// The next message's number is read afresh.
		const next = viewContext({ seq: "42" });
		await keptView(next.c as never, "repo:acme--web", "snapshot", 20_000, build);
		expect(next.reads.count).toBe(1);
	});

	it("aren't shared without a number, or when the reader asks for a fresh one", async () => {
		const kept = stubCache();
		const plain = viewContext({});
		await keptView(plain.c as never, "repo:acme--web", "snapshot", 20_000, build);
		const fresh = viewContext({ seq: "41" }, { "Cache-Control": "no-cache" });
		expect((await keptView(fresh.c as never, "repo:acme--web", "snapshot", 20_000, build)).status).toBe(200);
		await Promise.all([plain.settled(), fresh.settled()]);
		expect(kept.size).toBe(0);
	});
});
