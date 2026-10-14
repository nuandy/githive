import type { PageMessage } from "../../src/page-feed";
import { FakeStorage } from "./env";

const { RepoCache } = await import("../../src/repo-cache");

/**
 * A repo's cache with one page watching through a feed shard that records what it's sent: the messages, and their
 * kinds. The shard is told each message as the cache sends it, so a test reads them as soon as the call returns.
 */
export async function watchedCache(storage = new FakeStorage()) {
	const messages: PageMessage[] = [];
	const sent: string[] = [];
	const shard = {
		send: async (message: string) => {
			messages.push(JSON.parse(message));
			sent.push(messages.at(-1)!.kind);
			return 1;
		},
	};
	const env = { FEED_SHARD: { getByName: () => shard } };
	const cache = new RepoCache({ storage, waitUntil: () => undefined } as never, env as never);
	await cache.feedShardFor("acme--web");
	return { cache, messages, sent };
}
