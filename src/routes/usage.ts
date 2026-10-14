import type { Hono } from "hono";
import { OrgStore } from "../auth/orgs";
import { fail } from "../errors";
import { canReadUsage, type UsageEnv, type UsageRange, workerName, workerUse } from "../usage/analytics";
import { ownUsage } from "../usage/own-usage";
import type { AppEnv } from "./shared";

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
		const [use, owned] = await Promise.all([
			workerUse(env, range),
			new OrgStore(c.env.DB).ownedRepos(principal.user.id),
		]);
		const repos = owned.map((repo) => ({ id: repo.id, fullName: repo.fullName }));
		return c.json({ range, ...ownUsage(use, workerName(env), repos) });
	});
}
