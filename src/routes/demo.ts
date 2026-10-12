import type { Hono } from "hono";
import { BACKLOG } from "../demo/backlog";
import { DEMO_AGENT, clearLastRun, demoContext, demoRepo, demoRepoName, startReset } from "../demo/demo-repo";
import { runBacklog } from "../demo/run";
import { fail, statusOf } from "../errors";
import { rpc } from "../rpc";
import { callTool } from "../toolkit/mcp";
import type { AppEnv } from "./shared";

// Honeycomb demo runs, for anyone signed in: GitHive's hosted agents build a small word game in the one public demo
// repo while they watch its Hive tab (see demo/demo-repo.ts and demo/demo-run.ts). One runs at a time and up to 100 a
// day, since every run spends GitHive's model account.

export function demoRoutes(app: Hono<AppEnv>) {
	app.post("/demo/runs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") fail(403, "a demo run is started by a person, signed in to GitHive");
		const { fullName } = demoRepoName(c.env);
		const registry = c.env.DEMO_RUN.getByName("registry");
		const reserved = await rpc(registry.reserve({ fullName, since: Date.now() }));
		if (!reserved.slot) fail(429, reserved.refused ?? "a demo run can't start now");
		const { id, number } = reserved.slot;
		try {
			const run = await setUpRun(c.env, number);
			const begin = { id, number, repo: run.repo, fullName, by: principal.user.handle, ...run.reset };
			await rpc(c.env.DEMO_RUN.getByName(`run:${id}`).begin(begin));
		} catch (err) {
			await rpc(registry.release(id)).catch(() => undefined);
			console.error(`setting up demo run ${number} failed`, statusOf(err).message);
			throw err;
		}
		return c.json({ id, repo: fullName }, 201);
	});

	// The run going now and the latest ones, with how the newest is doing.
	app.get("/demo/runs", async (c) => {
		const registry = await rpc(c.env.DEMO_RUN.getByName("registry").runs());
		const newest = registry.recent[0];
		const run = newest ? await rpc(c.env.DEMO_RUN.getByName(`run:${newest.id}`).status()) : null;
		return c.json({ running: registry.running ?? null, recent: registry.recent, newest: run });
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

/** The demo repo ready for run `number`: the last run cleared and a reset started, then this run's backlog. */
async function setUpRun(env: Env, number: number) {
	const repo = await demoRepo(env);
	let reset: string | undefined;
	if (!repo.made) {
		await clearLastRun(env, repo.id, number);
		reset = await startReset(env, repo.id, number);
	}
	const items = runBacklog(BACKLOG, number);
	await callTool("add_work", { repo: repo.id, agent: DEMO_AGENT, items }, demoContext(env));
	return { repo: repo.id, reset: reset ? { reset } : {} };
}
