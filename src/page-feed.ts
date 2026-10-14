// What a repo's dashboard pages are sent on their WebSocket (see RepoCache.publish). Each message says what changed
// (`kind`), carries the hive events that came with it so a page can show them without reading the feed again, and has
// a number of its own. A page that reconnects says the last number it had and is sent what it missed, or is told it
// missed too much and reads everything again.

import type { HiveEvent } from "./hive-events";

/** One message to the dashboard's pages. */
export interface PageMessage {
	seq: number;
	kind: string;
	at: string;
	events?: HiveEvent[];
	/** How long, at most, pages wait before reading again: set when so many watch that their reads would pile up. */
	spreadMs?: number;
}

/** How many watching pages a repo has before they're asked to spread their reads. */
const SPREAD_FROM = 50;
const MOST_SPREAD_MS = 2_000;

/**
 * How long `pages` watching pages should spread their reads over: none for a few, then a fifth of a millisecond a page,
 * so the first reads fill the Worker's cache for the rest.
 */
export const spreadFor = (pages: number) => (pages < SPREAD_FROM ? 0 : Math.min(MOST_SPREAD_MS, Math.round(pages / 5)));

const SENT = "page-sent";
const PAGE = "page:";
/** How many messages are kept for pages that reconnect. */
export const PAGES_KEPT = 200;

/** The storage the messages are kept in: a Durable Object's. */
type Storage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;

/** The keys a forgotten repo clears. */
export const PAGE_PREFIXES = [PAGE, SENT];

const pageKey = (seq: number) => `${PAGE}${String(seq).padStart(12, "0")}`;

/** Numbers and keeps a message, and returns it to send. */
export async function keepPageMessage(
	storage: Storage,
	kind: string,
	events: HiveEvent[],
	spreadMs = 0,
): Promise<PageMessage> {
	const seq = (await sentCount(storage)) + 1;
	const message: PageMessage = {
		seq,
		kind,
		at: new Date().toISOString(),
		...(events.length ? { events } : {}),
		...(spreadMs ? { spreadMs } : {}),
	};
	await storage.put({ [SENT]: seq, [pageKey(seq)]: message });
	if (seq > PAGES_KEPT) await storage.delete(pageKey(seq - PAGES_KEPT));
	return message;
}

/**
 * The messages after `since`, oldest first, for a page that reconnects: none if it's up to date, or a single `missed`
 * message if some are no longer kept, or the count started again (the repo's cache was cleared), so it reads
 * everything again.
 */
export async function pageMessagesSince(storage: Storage, since: number): Promise<PageMessage[]> {
	const sent = await sentCount(storage);
	if (since === sent) return [];
	const missed: PageMessage[] = [{ seq: sent, kind: "missed", at: new Date().toISOString() }];
	if (since > sent || sent - since > PAGES_KEPT) return missed;
	const range = { prefix: PAGE, start: pageKey(since + 1), end: pageKey(sent + 1) };
	const kept = [...(await storage.list<PageMessage>(range)).values()];
	return kept.length < sent - since ? missed : kept;
}

const sentCount = async (storage: Storage) => (await storage.get<number>(SENT)) ?? 0;
