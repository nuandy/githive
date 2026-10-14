import type { Context } from "hono";
import { Timing } from "../timing";
import type { AppEnv } from "./shared";

// Dashboard views kept in a repo's cache (see repo-cache.ts), served stale while they rebuild. A page reading again
// because of a live-feed message names that message's number (`?seq=`), and every reader of the same view at the same
// number gets the same answer, so it's shared through the Worker's cache: however many watch, one read per location
// reaches the repo's cache.

/** Views bigger than this aren't kept (a Durable Object value holds up to 2 MB). */
const MAX_KEPT_VIEW = 1_000_000;

/** How long a view read at a feed number is shared; the next message has a new number anyway. */
const SHARED_SECONDS = 10;

/**
 * Serves a dashboard view kept in the repo's cache. A stale view is served while one rebuild runs in the background.
 * A view is built on the spot only when none is kept or the reader asks for a fresh one.
 */
export async function keptView(
	c: Context<AppEnv>,
	key: string,
	name: string,
	maxAgeMs: number,
	build: (timing: Timing) => Promise<unknown>,
) {
	// "Cache-Control: no-cache" asks for a fresh build, for example right after the reader's own write.
	const wantsFresh = /no-cache/.test(c.req.header("Cache-Control") ?? "");
	const shared = wantsFresh ? null : sharedKey(key, name, c.req.query("seq"));
	const hit = shared ? await sharedCache()?.match(shared) : undefined;
	if (hit) return hit;
	const cache = c.env.REPO_CACHE.getByName(key);
	const kept = await cache.view(name, maxAgeMs);
	const rebuild = async (timing: Timing) => {
		try {
			const json = JSON.stringify(await timing.time("total", () => build(timing)));
			if (json.length <= MAX_KEPT_VIEW) await cache.keep(name, json, kept.writes);
			else await cache.buildFailed(name);
			return json;
		} catch (err) {
			await cache.buildFailed(name).catch(() => undefined);
			throw err;
		}
	};
	const send = (json: string, timing: string) => {
		if (shared) c.executionCtx.waitUntil(share(shared, json));
		return c.body(json, 200, { "Content-Type": "application/json", "Server-Timing": timing });
	};
	if (kept.json !== undefined && !wantsFresh) {
		if (!kept.fresh && !kept.building && (await cache.startBuild(name)))
			c.executionCtx.waitUntil(
				rebuild(new Timing()).catch((err) => console.error(`rebuilding ${key} ${name} failed`, String(err))),
			);
		return send(kept.json, `view;desc=${kept.fresh ? "fresh" : "stale"}`);
	}
	const timing = new Timing();
	await cache.startBuild(name);
	const json = await rebuild(timing);
	return send(json, `view;desc=built, ${timing.header()}`);
}

/** Where a view read at feed number `seq` is shared, or null when the reader named none. */
function sharedKey(key: string, name: string, seq: string | undefined) {
	if (!seq || !/^\d+$/.test(seq)) return null;
	return new Request(`https://views.githive.internal/${encodeURIComponent(key)}/${encodeURIComponent(name)}/${seq}`);
}

// The Worker's cache, where there is one (not in tests).
const sharedCache = () => (typeof caches === "undefined" ? undefined : caches.default);

async function share(shared: Request, json: string) {
	const headers = { "Content-Type": "application/json", "Cache-Control": `max-age=${SHARED_SECONDS}` };
	await sharedCache()?.put(shared, new Response(json, { headers }));
}
