import type { Hono } from "hono";
import { BACKLOG } from "../demo/backlog";
import { repoIdFor } from "../auth/orgs";
import { demoRepoName } from "../demo/demo-repo";
import { DEMO_AGENTS } from "../demo/run";
import { fail, statusOf } from "../errors";
import { rpc } from "../rpc";
import type { AppEnv } from "./shared";

// Honeycomb demo runs, for anyone signed in: GitHive's hosted agents build a small word game in the one public demo
// repo while they watch its Hive tab (see demo/demo-repo.ts and demo/demo-run.ts). One runs at a time and up to 100 a
// day, since every run spends GitHive's model account.

export function demoRoutes(app: Hono<AppEnv>) {
	app.post("/demo/runs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") fail(403, "a demo run is started by a person, signed in to GitHive");
		const { owner, name, fullName } = demoRepoName(c.env);
		const registry = c.env.DEMO_RUN.getByName("registry");
		const reserved = await rpc(registry.reserve({ fullName, since: Date.now() }));
		if (!reserved.slot) fail(429, reserved.refused ?? "a demo run can't start now");
		const { id, number } = reserved.slot;
		// The run sets itself up in its own object, so a request cut short can't leave it half done.
		const begin = { id, number, repo: repoIdFor(owner, name), fullName, by: principal.user.handle };
		await rpc(c.env.DEMO_RUN.getByName(`run:${id}`).begin(begin)).catch(async (err) => {
			await rpc(registry.release(id)).catch(() => undefined);
			console.error(`starting demo run ${number} failed`, statusOf(err).message);
			throw err;
		});
		return c.json({ id, repo: fullName }, 201);
	});

	// The run going now and the latest ones, with how the newest is doing.
	app.get("/demo/runs", async (c) => {
		const registry = await rpc(c.env.DEMO_RUN.getByName("registry").runs());
		const newest = registry.recent[0];
		const run = newest ? await rpc(c.env.DEMO_RUN.getByName(`run:${newest.id}`).status()) : null;
		const newestRun = run ? { ...run, pieces: BACKLOG.length } : null;
		// How many agents a run starts, so the dashboard says so before any run has.
		const body = { running: registry.running ?? null, recent: registry.recent, newest: newestRun };
		return c.json({ ...body, agentsPerRun: DEMO_AGENTS });
	});

	// The latest run on a repo, for its Hive tab's banner: none unless it's the demo repo and a run has started.
	app.get("/demo/runs/:owner/:name", async (c) => {
		const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
		const registry = await rpc(c.env.DEMO_RUN.getByName("registry").runs());
		const newest = registry.recent.find((run) => run.fullName === fullName);
		const run = newest ? await rpc(c.env.DEMO_RUN.getByName(`run:${newest.id}`).status()) : null;
		if (!run) fail(404, `no demo run on ${fullName}`);
		return c.json({ ...run, pieces: BACKLOG.length });
	});
}
