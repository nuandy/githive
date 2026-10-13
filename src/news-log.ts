// What agents are told, kept in a log by the doorbell's count (see RepoCache.ring): each ring that carries notices or
// a landing leaves an entry, and each reader reads from a cursor of its own, so nothing is deleted on the way out. An
// agent's replies move its cursor as they're made, except `wait`'s: a `wait` reply tells only what rang up to its
// `seen`, and the cursor moves there when the next call brings that `seen` back. A lost `wait` reply then loses
// nothing: the next call, with the older `seen`, is told it again. A cursor older than the log is told it missed some.

import type { NewsItem, Notice } from "./repo-cache";
import type { Landed } from "./toolkit/landing";

/** What one ring told: notices for agents, and what landed on a branch. */
export interface Told {
	notices?: { agent: string; notice: Notice }[];
	landed?: { branch: string; news: Landed[] };
}

/** How a reply's news is delivered: `wait` passes the `seen` it was called with, and the one it answers with. */
export interface Delivery {
	/** The ring count of the `seen` the call brought: its last reply arrived, so the cursor may move there. */
	ack?: number;
	/** Tell only what rang up to here, and leave the cursor for the next call's `ack`. */
	through?: number;
}

const TOLD = "told:";
const CURSOR = "cursor:";
/** The newest count trimmed from the log, and how many entries it holds. */
const TRIMMED = "told-trimmed";
const COUNT = "told-count";
/** How many entries the log keeps, and how many more it takes before it's trimmed back to that. */
export const TOLD_KEPT = 1_000;
const TRIM_EVERY = 50;
/** The most landings one reply tells, the newest kept, and the most notices. */
const LANDED_MOST = 20;
const NOTICES_MOST = 50;
/** How long a notice is worth telling. */
const NOTICE_MS = 24 * 60 * 60_000;

/** The storage the log is kept in: a Durable Object's. */
type Storage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;

export const toldKey = (rings: number) => `${TOLD}${String(rings).padStart(12, "0")}`;

/** Where the time of `agent`'s newest notice is kept, which `wait` watches. */
export const noticeAtKey = (agent: string) => `notice-at:${agent}`;

/** The keys a forgotten repo clears. */
export const NEWS_PREFIXES = [TOLD, CURSOR, "notice-at:", TRIMMED, COUNT];

/**
 * Keeps the time of each agent's newest notice, in puts of at most 128 keys, as a Durable Object's storage takes: a
 * notice can go to hundreds of agents.
 */
export async function keepNoticeTimes(storage: Storage, told: Told) {
	const newest = new Map<string, string>();
	for (const { agent, notice } of told.notices ?? [])
		if ((newest.get(agent) ?? "") < notice.at) newest.set(agent, notice.at);
	const times = [...newest].map(([agent, at]) => [noticeAtKey(agent), at] as const);
	for (let from = 0; from < times.length; from += 128)
		await storage.put(Object.fromEntries(times.slice(from, from + 128)));
}

/**
 * Counts an entry just kept, and once the log holds TRIM_EVERY more than TOLD_KEPT, deletes the oldest down to it,
 * reading only those.
 */
export async function trimTold(storage: Storage) {
	const count = ((await storage.get<number>(COUNT)) ?? 0) + 1;
	if (count <= TOLD_KEPT + TRIM_EVERY) return void (await storage.put(COUNT, count));
	const dropped = [...(await storage.list({ prefix: TOLD, limit: count - TOLD_KEPT })).keys()];
	for (let from = 0; from < dropped.length; from += 128) await storage.delete(dropped.slice(from, from + 128));
	await storage.put({ [COUNT]: count - dropped.length, [TRIMMED]: Number(dropped.at(-1)!.slice(TOLD.length)) });
}

/**
 * What `agent` hasn't been told, as of `rings`: a missed note if its cursor is older than the log, other agents'
 * landings on `branch`, newest last, then its notices on every branch, oldest first. A first call starts the cursor:
 * it's told the notices waiting for it, but nothing that landed before it came.
 */
export async function newsFor(
	storage: Storage,
	rings: number,
	at: { branch: string; agent: string },
	delivery: Delivery = {},
): Promise<NewsItem[]> {
	const key = `${CURSOR}${at.agent}`;
	const cursor = await movedCursor(storage, key, rings, delivery.ack);
	const through = Math.min(delivery.through ?? rings, rings);
	const told = await toldBetween(storage, cursor ?? 0, through);
	const landed = cursor === undefined ? [] : landedFor(told, at);
	const notices = noticesFor(told, (_, agent) => agent === at.agent);
	const missed = cursor !== undefined && cursor < ((await storage.get<number>(TRIMMED)) ?? 0);
	if (delivery.through === undefined && (cursor === undefined || through > cursor)) await storage.put(key, through);
	return [...(missed ? [missedNews()] : []), ...landed, ...notices];
}

/**
 * The notices about `change` for `agent` that a reader of its own (GitHive's hosted builder) hasn't had, from that
 * reader's cursor. The agent's own replies still tell them.
 */
export async function changeNoticesFor(storage: Storage, rings: number, agent: string, change: string) {
	const key = `${CURSOR}${agent}:${change}`;
	const cursor = (await storage.get<number>(key)) ?? 0;
	const told = await toldBetween(storage, cursor, rings);
	if (rings > cursor) await storage.put(key, rings);
	return noticesFor(told, (notice, to) => to === agent && notice.change === change);
}

// The cursor, moved on to `ack` when the call shows its last reply arrived.
async function movedCursor(storage: Storage, key: string, rings: number, ack: number | undefined) {
	const cursor = await storage.get<number>(key);
	if (ack === undefined || ack > rings) return cursor;
	if (cursor !== undefined && ack <= cursor) return cursor;
	await storage.put(key, ack);
	return ack;
}

async function toldBetween(storage: Storage, after: number, through: number) {
	if (through <= after) return [];
	const range = { prefix: TOLD, start: toldKey(after + 1), end: toldKey(through + 1) };
	return [...(await storage.list<Told>(range)).values()];
}

function landedFor(told: Told[], at: { branch: string; agent: string }): NewsItem[] {
	const landed = told.flatMap((entry) => (entry.landed?.branch === at.branch ? entry.landed.news : []));
	const others = landed.filter((news) => news.agent !== at.agent).slice(-LANDED_MOST);
	return others.map((news) => ({ kind: "landed" as const, ...news }));
}

function noticesFor(told: Told[], wanted: (notice: Notice, agent: string) => boolean) {
	const now = Date.now();
	const notices = told.flatMap((entry) =>
		(entry.notices ?? []).filter(({ agent, notice }) => wanted(notice, agent)).map(({ notice }) => notice),
	);
	const current = notices.filter((notice) => now - Date.parse(notice.at) <= NOTICE_MS);
	return current.sort((one, other) => one.at.localeCompare(other.at)).slice(-NOTICES_MOST);
}

function missedNews(): Notice {
	return {
		kind: "missed",
		at: new Date().toISOString(),
		says: "Some news is older than GitHive keeps, so it wasn't told here",
		next: "Call `status` on your changes, then `reviews` and `backlog`, to see where things stand.",
	};
}
