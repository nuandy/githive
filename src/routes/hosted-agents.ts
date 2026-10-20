import type { Hono } from "hono";
import { type Principal, isPerson } from "../auth/principal";
import { fail } from "../errors";
import { HOUSE, NO_MODEL, hasModel } from "../models/payer";
import { rpc } from "../rpc";
import { MOST_HIVE_AGENTS } from "../toolkit/hive-agents";
import { type AppEnv, jsonArgs, routeRepo } from "./shared";

// GitHive's hosted agents as members of a repo's hive (see hosted-agents.ts): a person who can write to the repo starts
// a few for a while, and they take the backlog and reviews the way any agent does until their time is up.

export const HIVE_MINUTES = { least: 5, most: 120, usual: 60 };

/** How many agents to start and for how long, from a request's body; out of range is refused. */
export function hiveRequest(body: Record<string, unknown>) {
	const count = body.count ?? 3;
	const minutes = body.minutes ?? HIVE_MINUTES.usual;
	if (!inRange(count, 1, MOST_HIVE_AGENTS)) fail(400, `count is a whole number from 1 to ${MOST_HIVE_AGENTS}`);
	if (!inRange(minutes, HIVE_MINUTES.least, HIVE_MINUTES.most))
		fail(400, `minutes is a whole number from ${HIVE_MINUTES.least} to ${HIVE_MINUTES.most}`);
	return { count: count as number, minutes: minutes as number };
}

function inRange(value: unknown, least: number, most: number) {
	if (!Number.isInteger(value)) return false;
	if ((value as number) < least) return false;
	return (value as number) <= most;
}

/** Whose model the hive runs on: the person starting it, or the house's for GitHive's operators. */
const payerOf = (principal: Principal) => (principal.kind === "user" ? principal.user.id : HOUSE);

export function hostedAgentRoutes(app: Hono<AppEnv>) {
	const hiveOf = (env: Env, repo: string) => env.HOSTED_AGENT.getByName(`hive:${repo}`);

	app.get("/repos/:owner/:name/hosted-agents", async (c) => {
		const repo = await routeRepo(c, "read");
		return c.json(await rpc(hiveOf(c.env, repo.id).status()));
	});

	app.post("/repos/:owner/:name/hosted-agents", async (c) => {
		const repo = await routeRepo(c, "write");
		const principal = c.get("principal")!;
		if (!isPerson(principal)) fail(403, "hosted agents are started by a person, from the dashboard");
		const payer = payerOf(principal);
		if (!(await hasModel(c.env, payer))) fail(403, NO_MODEL);
		const { count, minutes } = hiveRequest(await jsonArgs(c));
		// Their hive is shown to anyone who can read the repo, so it names a person by handle, never by email.
		const by = principal.kind === "user" ? principal.user.handle : "GitHive";
		const hive = { repo: repo.id, count, minutes, by, payer };
		return c.json(await rpc(hiveOf(c.env, repo.id).start(hive)), 201);
	});

	app.delete("/repos/:owner/:name/hosted-agents", async (c) => {
		const repo = await routeRepo(c, "write");
		return c.json(await rpc(hiveOf(c.env, repo.id).stopAll()));
	});
}
