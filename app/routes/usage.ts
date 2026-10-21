import type { Hono } from "hono";
import { OrgStore } from "../../src/auth/orgs";
import { fail } from "../../src/errors";
import { canReadUsage, type UsageEnv, type UsageRange, workerName, workerUse } from "../usage/analytics";
import { ownHours } from "../usage/own-hours";
import { ownUsage } from "../usage/own-usage";
import type { AppEnv } from "../../src/routes/shared";

// GET /usage?range=24h|7d: what the caller's own repos used on Cloudflare, and what it costs at list prices. Whose
// repos is decided here, from who's signed in, never from the request; the Worker's whole usage never leaves.

const RANGES: UsageRange[] = ["24h", "7d"];

export function usageRoutes(app: Hono<AppEnv>) {
	app.get("/usage", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") fail(403, "usage is shown to a person, signed in to GitHive");
		const range = (c.req.query("range") ?? "24h") as UsageRange;
		if (!RANGES.includes(range)) fail(400, "range is 24h or 7d");
		const env = c.env as unknown as UsageEnv;
		if (!canReadUsage(env) || !c.env.DB)
			fail(503, "Usage isn't set up on this GitHive yet: it needs a Cloudflare analytics token.");
		const origin = new URL(c.req.url).origin;
		const [read, owned] = await Promise.all([
			workerUse(env, range, origin),
			new OrgStore(c.env.DB).ownedRepos(principal.user.id),
		]);
		const use = read.value;
		const repos = owned.map((repo) => ({ id: repo.id, fullName: repo.fullName }));
		// The chart is extra: if its hours can't be read, the table still shows, with the reason in the chart's place.
		const hours = await ownHours(env, use, repos, principal.user.id, origin).then(
			(kept) => ({ hours: kept.value, kept: kept.kept }),
			(error: Error) => ({ hoursError: error.message, kept: false }),
		);
		const { kept: hoursKept, ...chart } = hours;
		// Whether each read came from the cache, for anyone checking that it's kept.
		const timing = `analytics;desc=${read.kept ? "kept" : "read"}, hours;desc=${hoursKept ? "kept" : "read"}`;
		c.header("Server-Timing", timing);
		return c.json({ range, ...ownUsage(use, workerName(env), repos), ...chart });
	});
}
