import type { Context, Hono } from "hono";
import { listRepoNames } from "../artifacts";
import { openFeed } from "../feed-shard";
import { retryTransient } from "../retry";
import { type AppEnv, forgetRepo, isProject, jsonArgs, repoIndex, requireAccess } from "./shared";

// Routes for GitHive's operators through Cloudflare Access: the bench-only Artifacts probes and wipe, and repo feeds.

const artifactsError = (err: unknown) => ({
	code: err && typeof err === "object" && "code" in err ? String(err.code) : null,
	message: err instanceof Error ? err.message : String(err),
});

// Bench only (BENCH_WIPE is never set in production): delete every repo in the namespace. Each call deletes one batch
// because a request can make only so many subrequests, so call again until nothing remains.
const WIPE_CONFIRMATION = "delete every repo in the bench namespace";
const WIPE_BATCH = 400;
const WIPE_PARALLEL = 8;

/** Refuses a bench-only route outside the bench or to a caller not through Cloudflare Access. */
function benchOnlyRefusal(c: Context<AppEnv>) {
	if ((c.env as unknown as { BENCH_WIPE?: string }).BENCH_WIPE !== "allowed")
		return c.json({ error: "not available here" }, 404);
	if (c.get("principal")?.kind !== "access") return c.json({ error: "only through Cloudflare Access" }, 403);
	return null;
}

/** Deletes one repo and, for a project, its tokens and kept views. */
async function deleteRepo(env: Env, name: string) {
	await retryTransient(() => env.ARTIFACTS.delete(name));
	if (isProject(name)) await forgetRepo(env, name);
}

export function adminRoutes(app: Hono<AppEnv>) {
	// Bench only: whether Artifacts lists a repo and what get() answers, to tell an unfinished fork from a missing one.
	app.get("/admin/artifacts/:name", async (c) => {
		const refusal = benchOnlyRefusal(c);
		if (refusal) return refusal;
		const name = c.req.param("name");
		const listed = (await listRepoNames(c.env.ARTIFACTS)).includes(name);
		const got = await c.env.ARTIFACTS.get(name).then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, ...artifactsError(err) }),
		);
		return c.json({ name, listed, get: got });
	});

	// Bench only: delete one repo, such as a fork stuck forking, and report what Artifacts answered.
	app.delete("/admin/artifacts/:name", async (c) => {
		const refusal = benchOnlyRefusal(c);
		if (refusal) return refusal;
		const name = c.req.param("name");
		const deleted = await c.env.ARTIFACTS.delete(name).then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, ...artifactsError(err) }),
		);
		return c.json({ name, deleted });
	});

	app.post("/admin/wipe", async (c) => {
		const refusal = benchOnlyRefusal(c);
		if (refusal) return refusal;
		const { confirm, batch: requestedSize } = await jsonArgs(c);
		if (confirm !== WIPE_CONFIRMATION) return c.json({ error: `confirm with "${WIPE_CONFIRMATION}"` }, 400);
		await repoIndex(c.env).clear();
		const names = await listRepoNames(c.env.ARTIFACTS);
		const batchSize =
			typeof requestedSize === "number" && requestedSize > 0 ? Math.min(requestedSize, WIPE_BATCH) : WIPE_BATCH;
		const batch = names.slice(0, batchSize);
		const failed: string[] = [];
		// Delete a few at a time, since one by one a batch takes too long.
		for (let start = 0; start < batch.length; start += WIPE_PARALLEL) {
			const group = batch.slice(start, start + WIPE_PARALLEL);
			await Promise.all(group.map((name) => deleteRepo(c.env, name).catch(() => failed.push(name))));
		}
		console.log(
			"bench wipe",
			JSON.stringify({
				deleted: batch.length - failed.length,
				failed: failed.length,
				remaining: names.length - batch.length,
			}),
		);
		return c.json({
			deleted: batch.length - failed.length,
			failed,
			remaining: names.length - batch.length + failed.length,
		});
	});

	// Live updates: a page opens a WebSocket on its repo's feed ("repo:<repo>") and refreshes when pinged.
	app.get("/live/:key", async (c) => {
		requireAccess(c);
		const key = c.req.param("key");
		if (!/^repo:[A-Za-z0-9._-]+$/.test(key)) return c.json({ error: "not a feed" }, 400);
		return openFeed(c.env, key.slice("repo:".length), c.req.raw);
	});
}
