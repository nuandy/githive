import type { Context } from "hono";
import { type Principal, agentNameOf, byOf } from "../auth/principal";
import { type RepoRef, resolveRepo } from "../auth/access-control";
import { type Level, OrgStore } from "../auth/orgs";
import { IdentityStore } from "../auth/store";
import { changeCache } from "../change-cache";
import { fail } from "../errors";
import { rpc } from "../rpc";
import type { ToolContext } from "../toolkit/mcp";
import { toolContextFor } from "../toolkit/env";

// What the route files share: the app's environment, the request body, the caller's access and tools, and what goes
// when a repo is deleted.

export type AppEnv = { Bindings: Env; Variables: { principal?: Principal } };

export const repoIndex = (env: Env) => env.REPO_INDEX.getByName("all");

/** The request's JSON object body, or an empty object when it is missing or not JSON. */
export const jsonArgs = async (c: { req: { json<T>(): Promise<T> } }) => {
	const body = await c.req.json<Record<string, unknown> | null>().catch(() => null);
	return body && typeof body === "object" ? body : {};
};

/** Allows only callers through Cloudflare Access: GitHive's operators and their scripts. */
export const requireAccess = (c: Context<AppEnv>) => {
	if (c.get("principal")?.kind !== "access") fail(403, "only through Cloudflare Access");
};

/** The repo a route names (/repos/:owner/:name), if the caller may do `needed` in it. */
export const routeRepo = (c: Context<AppEnv>, needed: Level): Promise<RepoRef> =>
	resolveRepo(c.env, c.get("principal"), `${c.req.param("owner")}/${c.req.param("name")}`, needed);

/** GitHive's tools for this caller. A signed-in agent needs no key. */
export const toolContext = (env: Env, principal: Principal | undefined, agentKey?: string): ToolContext => {
	const agent = principal && agentNameOf(principal);
	// A person's teams in the repo's org go into their votes, for roles granted to a team.
	const teamsOf =
		principal && principal.kind !== "access" && env.DB
			? (repo: string) => new OrgStore(env.DB).teamsForRepo(principal.user.id, repo)
			: undefined;
	// Hosted agents spend GitHive's model account, so only people an admin lists may use them.
	const mayUseHosted =
		principal && principal.kind !== "access"
			? async () => !!env.DB && (await new IdentityStore(env.DB).mayUseHosted(principal.user.id))
			: undefined;
	const caller: Parameters<typeof toolContextFor>[2] = {};
	if (agent) caller.agent = agent;
	else if (agentKey) caller.agentKey = agentKey;
	if (teamsOf) caller.teamsOf = teamsOf;
	if (mayUseHosted) caller.mayUseHosted = mayUseHosted;
	return toolContextFor(env, principal ? byOf(principal) : undefined, caller);
};

/** Agents' forks and claim records repos aren't projects. */
export const isProject = (name: string) => !name.startsWith("fork--") && !name.startsWith("records--");

/**
 * A deleted project's tokens, caches and GitHub sync state go with it, so a new repo by its name starts clean.
 */
export async function forgetRepo(env: Env, repo: string) {
	await Promise.resolve()
		// Forget the snapshot too. Containers can't delete one early and drops it within 30 days.
		.then(() =>
			Promise.all([
				env.TOKENS?.getByName(repo).clear(),
				forgetCaches(env, repo),
				env.GITHUB_SYNC?.getByName(`repo:${repo}`).forget(),
				env.GATE?.getByName(`repo:${repo}`).forgetSnapshot(),
			]),
		)
		.catch((err) => console.error(`forgetting ${repo}'s tokens, caches, GitHub sync and snapshot failed`, String(err)));
}

// The repo's RepoCache, and the RecordCaches, ChangeCache and FootprintCache beside it.
async function forgetCaches(env: Env, repo: string) {
	if (!env.REPO_CACHE) return;
	const recordCaches = await rpc(env.REPO_CACHE.getByName(`repo:${repo}`).clearViews());
	await Promise.all([
		...recordCaches.map((name) => env.RECORD_CACHE.getByName(name).forget()),
		changeCache(env, repo).forget(),
		env.FOOTPRINT_CACHE?.getByName(`footprints:${repo}`).forget(),
	]);
}
