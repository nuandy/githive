import type { Context } from "hono";
import { Timing } from "../timing";
import type { AppEnv } from "./shared";

// Dashboard views kept in a repo's cache (see repo-cache.ts), served stale while they rebuild.

/** Views bigger than this aren't kept (a Durable Object value holds up to 2 MB). */
const MAX_KEPT_VIEW = 1_000_000;

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
	const send = (json: string, timing: string) =>
		c.body(json, 200, { "Content-Type": "application/json", "Server-Timing": timing });
	// "Cache-Control: no-cache" asks for a fresh build, for example right after the reader's own write.
	const wantsFresh = /no-cache/.test(c.req.header("Cache-Control") ?? "");
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
