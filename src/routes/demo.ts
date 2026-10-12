import type { Hono } from "hono";
import { type Org, OrgStore } from "../auth/orgs";
import { ensureRepo, remoteFor } from "../artifacts";
import { demoContext } from "../demo/demo-run";
import { BACKLOG } from "../demo/backlog";
import { repoName } from "../demo/run";
import { TEMPLATE_FILES } from "../demo/template-files";
import { fail, statusOf } from "../errors";
import { writeFirstCommit } from "../repo-init";
import { rpc } from "../rpc";
import { callTool } from "../toolkit/mcp";
import type { AppEnv } from "./shared";

// Honeycomb demo runs, for anyone signed in: GitHive's hosted agents build a small word game in a fresh public repo of
// the person's own, while they watch its Hive tab (see demo/demo-run.ts). One runs at a time and a few a day, since
// every run spends GitHive's model account.

/** The settings a demo repo starts with: one approval from GitHive's reviewers, and the game's tests before landing. */
const DEMO_SETTINGS = { required: 1, verify: ["npm test"] };

export function demoRoutes(app: Hono<AppEnv>) {
	app.post("/demo/runs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") fail(403, "a demo run is started by a person, signed in to GitHive");
		const user = principal.user;
		const org = await new OrgStore(c.env.DB).personalOrg(user);
		const now = Date.now();
		const name = repoName(now);
		const id = `${org.slug}--${name}`;
		const fullName = `${org.slug}/${name}`;
		const registry = c.env.DEMO_RUN.getByName("registry");
		const reserved = await rpc(registry.reserve({ id, fullName, since: now }));
		if (reserved.refused) fail(429, reserved.refused);
		try {
			await setUpRepo(c.env, org, user.id, name, id);
			await rpc(c.env.DEMO_RUN.getByName(`run:${id}`).begin({ id, repo: id, fullName, by: user.handle }));
		} catch (err) {
			await rpc(registry.release(id)).catch(() => undefined);
			console.error(`setting up demo run ${fullName} failed`, statusOf(err).message);
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

	app.get("/demo/runs/:owner/:name", async (c) => {
		const id = `${c.req.param("owner")}--${c.req.param("name")}`;
		const run = await rpc(c.env.DEMO_RUN.getByName(`run:${id}`).status());
		if (!run) fail(404, `no demo run ${c.req.param("owner")}/${c.req.param("name")}`);
		return c.json({ ...run, pieces: BACKLOG.length });
	});
}

/** The demo's repo, public in the person's namespace: the game's starting files, its settings and its backlog. */
async function setUpRepo(env: Env, org: Org, userId: string, name: string, id: string) {
	await ensureRepo(env.ARTIFACTS, id, `${org.slug}/${name}`);
	await writeFirstCommit(await remoteFor(env.ARTIFACTS, id, "write"), TEMPLATE_FILES, {
		name: "githive-demo",
		email: "githive-demo@agents.githive.app",
		message: "Lay out Honeycomb: the rules, each module's contract, the page shell and the word list",
	});
	await new OrgStore(env.DB).addRepo(org, name, userId, { visibility: "public", id });
	const ctx = demoContext(env);
	await callTool("settings", { repo: id, ...DEMO_SETTINGS }, ctx);
	const items = BACKLOG.map(({ id: piece, title, intent, paths, after }) => ({
		id: piece,
		title,
		intent,
		paths,
		...(after ? { after } : {}),
	}));
	await callTool("add_work", { repo: id, agent: "githive-demo", items }, ctx);
}
