import { type Context, Hono } from "hono";
import { type Principal, agentNameOf, byOf, isPerson, resolvePrincipal } from "./auth/principal";
import { authRoutes } from "./auth/routes";
import { authorize } from "./auth/authorize";
import { type RepoRef, resolveRepo, toolLevel } from "./auth/access-control";
import { type Level, OrgStore, validRepoName } from "./auth/orgs";
import { orgRoutes } from "./auth/org-routes";
import { IdentityStore } from "./auth/store";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { ensureRepo, forkAndWait, listRepoNames, remoteFor, reviewerName } from "./artifacts";
import { fail, statusOf } from "./errors";
import { retryTransient } from "./retry";
import { handleMcpBody } from "./mcp";
import { type ToolContext, repoAudit, changeHistory, openCount, repoSnapshot, voteAsPerson } from "./toolkit/mcp";
import { listTree, readFile } from "./code-browse";
import { Timing } from "./timing";
import { defaultBranch } from "./git";
import { changeRepoName, toolContextFor } from "./toolkit/env";

export { Builder } from "./builder";
export { Reviewer } from "./reviewer";
export { Gate } from "./gate";
export { RepoIndex } from "./repo-index";
export { LiveFeed } from "./live-feed";
export { TokenCache } from "./token-cache";

type AppEnv = { Bindings: Env; Variables: { principal?: Principal } };
const app = new Hono<AppEnv>();

const repoIndex = (env: Env) => env.REPO_INDEX.getByName("all");

/** A JSON body as arguments to check, or none when it is missing or not JSON. */
const jsonArgs = async (c: { req: { json<T>(): Promise<T> } }) => {
	const body = await c.req.json<Record<string, unknown> | null>().catch(() => null);
	return body && typeof body === "object" ? body : {};
};

/** Served to anyone: the dashboard's page and files (it asks people to sign in), sign-in itself, and OAuth's own endpoints. */
const isPublic = (path: string) => path === "/" || path === "/index.html" || path.startsWith("/assets/") || path.startsWith("/auth/") || path.startsWith("/.well-known/") || path === "/authorize";

// Authenticate before routing: Access, an agent token, or a session cookie (see auth/principal.ts).
app.use("*", async (c, next) => {
	const principal = await resolvePrincipal(c.req.raw, c.env);
	if (principal) c.set("principal", principal);
	else if (!isPublic(c.req.path)) return c.json({ error: "sign in to GitHive first" }, 401);
	// A session cookie rides along with any request to this site, so a write on one must come from this site's own pages.
	if (principal?.kind === "user" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Origin") !== new URL(c.req.url).origin)
		return c.json({ error: "refused: a signed-in write must come from GitHive's own pages" }, 403);
	await next();
});

app.onError((err, c) => {
	const { status, message } = statusOf(err);
	if (status >= 500) console.error("API error", err);
	return c.json({ error: message }, status as 400);
});

// Sign-in, the caller's own agents and tokens, and invitations.
authRoutes(app);
// Orgs, their members and teams.
orgRoutes(app);
// Where an MCP client sends a person to connect it as one of their agents (OAuth).
app.on(["GET", "POST"], "/authorize", authorize);

app.get("/api", (c) =>
	c.json({
		name: "githive",
		routes: [
			"GET  /            dashboard",
			"POST /mcp         (the MCP front door: JSON-RPC over HTTP; repo is <owner>/<name>)",
			"GET  /me          (who you are)",
			"GET  /auth/:provider  (sign in with github or google)",
			"GET|POST /me/agents, DELETE /me/agents/:id, POST /me/agents/:id/tokens, DELETE /me/tokens/:id  (your agents and their tokens)",
			"GET|DELETE /me/connections  (MCP clients connected as your agents)",
			"GET|POST /orgs, GET|PATCH /orgs/:org  (your orgs; one's repos, members and teams)",
			"POST /orgs/:org/members {email, role}, PATCH|DELETE /orgs/:org/members/:handle, DELETE /orgs/:org/invites/:email",
			"POST /orgs/:org/teams {slug}, DELETE /orgs/:org/teams/:team, PUT|DELETE /orgs/:org/teams/:team/members/:handle",
			"GET  /repos       (the repos you can see)",
			"POST /repos {owner, name, import_url? | copy_from?, visibility?}  (a new repo)",
			"GET  /summaries   (every repo you can see, with its counts)",
			"GET  /repos/:owner/:name  (claims and votes, from Git); /access (your permission)",
			"GET  /repos/:owner/:name/changes/:change  (one change's history)",
			"POST /repos/:owner/:name/changes/:change/votes {role, verdict, evidence}  (a person's vote; review)",
			"GET  /repos/:owner/:name/audit | /lanes | /tree?ref= | /file?path=&ref= | /live (WebSocket)",
			"PATCH /repos/:owner/:name {visibility}, GET|PUT|DELETE /repos/:owner/:name/collaborators[/:handle]  (admin)",
			"DELETE /repos/:owner/:name  (admin)",
			"Access admins: POST /repos/import, /repos/_/<id>/..., GET /admin/repos, POST /admin/repos/:id/adopt {owner, name}, GET|POST|DELETE /admin/invites",
		],
	}),
);

/** Only through Cloudflare Access: GitHive's operators and their scripts. */
const requireAccess = (c: Context<AppEnv>) => {
	if (c.get("principal")?.kind !== "access") fail(403, "only through Cloudflare Access");
};

/** The repo a route names (/repos/:owner/:name), if the caller may do `needed` in it. */
const routeRepo = (c: Context<AppEnv>, needed: Level): Promise<RepoRef> => resolveRepo(c.env, c.get("principal"), `${c.req.param("owner")}/${c.req.param("name")}`, needed);

/** Import a repo under an id that isn't in an org: for Access admins and their scripts (an org's repo is made with POST /repos). */
app.post("/repos/import", async (c) => {
	requireAccess(c);
	const { url, name, branch } = await c.req.json<{ url: string; name: string; branch?: string }>();
	const imported = await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } }));
	return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
});

/**
 * A new repo in an org (or your own namespace): imported from a Git URL, or
 * copied from a repo you can read (its default branch: seconds, where an
 * import takes a minute or more), or empty.
 */
app.post("/repos", async (c) => {
	const principal = c.get("principal") ?? fail(401, "sign in to GitHive first");
	const { owner, name, import_url: url, branch, copy_from: from, visibility } = await jsonArgs(c);
	if (typeof owner !== "string" || typeof name !== "string") fail(400, "owner and name are required");
	const repoName = String(name);
	if (!validRepoName(repoName)) fail(400, "a repo's name is letters, digits, dots, underscores or single dashes, up to 100");
	const orgs = new OrgStore(c.env.DB);
	// Your own namespace exists from your first sign-in; someone who signed in before orgs existed gets it now.
	if (principal.kind !== "access" && owner === principal.user.handle) await orgs.personalOrg(principal.user);
	const org = await orgs.orgOrFail(String(owner));
	const userId = principal.kind === "access" ? null : principal.user.id;
	if (userId && !(await orgs.mayCreateRepo(org, userId))) fail(403, `you can't make repos in ${org.slug}`);
	if (await orgs.repo(org.slug, repoName)) fail(409, `${org.slug}/${repoName} exists`);
	const id = `${org.slug}--${repoName.toLowerCase()}`;
	if (typeof from === "string" && from) {
		const source = await resolveRepo(c.env, principal, from, "read");
		await forkAndWait(c.env.ARTIFACTS, source.id, id, `A copy of ${source.fullName}`);
	} else if (typeof url === "string" && url) {
		await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch: typeof branch === "string" ? branch : undefined }, target: { name: id } }));
	} else {
		await ensureRepo(c.env.ARTIFACTS, id, `${org.slug}/${repoName}`);
	}
	const repo = await orgs.addRepo(org, repoName, userId, { visibility: visibility === "public" ? "public" : "private", id });
	return c.json(repo, 201);
});

// A new repo copied from this one, in the same namespace: for scripts (see POST /repos).
app.post("/repos/:owner/:name/copy", async (c) => {
	const source = await routeRepo(c, "read");
	const { name } = await jsonArgs(c);
	if (typeof name !== "string" || !name) fail(400, "name the new repo");
	if (c.get("principal")?.kind === "access" && c.req.param("owner") === "_") {
		// An Access admin copying a repo that isn't in an org: the copy isn't in one either.
		if (!isProject(String(name))) fail(400, "name the new repo: not a fork's or a records repo's name");
		const copied = await forkAndWait(c.env.ARTIFACTS, source.id, String(name), `A copy of ${source.fullName}`);
		return c.json({ name, remote: copied.remote });
	}
	fail(400, "copy into an org with POST /repos {owner, name, copy_from}");
});

/** GitHive's tools for this caller (see docs/design.md): stateless, Git only. A signed-in agent needs no key. */
const toolContext = (env: Env, principal: Principal | undefined, agentKey?: string): ToolContext => {
	const agent = principal && agentNameOf(principal);
	// A person's (or their agent's) teams in the repo's org go into their votes, for roles granted to a team.
	const teamsOf = principal && principal.kind !== "access" && env.DB ? (repo: string) => new OrgStore(env.DB).teamsForRepo(principal.user.id, repo) : undefined;
	return toolContextFor(env, principal ? byOf(principal) : undefined, { ...(agent ? { agent } : agentKey ? { agentKey } : {}), ...(teamsOf ? { teamsOf } : {}) });
};

/** Views bigger than this aren't kept (a Durable Object value holds up to 2 MB). */
const MAX_KEPT_VIEW = 1_000_000;

/**
 * A dashboard view kept in the repo's live feed (see live-feed.ts): served as
 * kept while fresh; when stale, served as kept while one fresh build runs in
 * the background, and pages are pinged when it's ready; built now only when
 * none is kept, or the reader asks for it fresh. Server-Timing says which
 * ("view;desc=fresh|stale|built").
 */
async function keptView(c: Context<AppEnv>, key: string, name: string, maxAgeMs: number, build: (timing: Timing) => Promise<unknown>) {
	const feed = c.env.LIVE.getByName(key);
	const kept = await feed.view(name, maxAgeMs);
	const rebuild = async (timing: Timing) => {
		try {
			const json = JSON.stringify(await timing.time("total", () => build(timing)));
			if (json.length <= MAX_KEPT_VIEW) await feed.keep(name, json, kept.writes);
			else await feed.buildFailed(name);
			return json;
		} catch (err) {
			await feed.buildFailed(name).catch(() => undefined);
			throw err;
		}
	};
	const send = (json: string, timing: string) => c.body(json, 200, { "Content-Type": "application/json", "Server-Timing": timing });
	// "Cache-Control: no-cache" (say, right after the reader's own write): build it now.
	const now = /no-cache/.test(c.req.header("Cache-Control") ?? "");
	if (kept.json !== undefined && !now) {
		if (!kept.fresh && !kept.building && (await feed.startBuild(name))) c.executionCtx.waitUntil(rebuild(new Timing()).catch((err) => console.error(`rebuilding ${key} ${name} failed`, String(err))));
		return send(kept.json, `view;desc=${kept.fresh ? "fresh" : "stale"}`);
	}
	const timing = new Timing();
	await feed.startBuild(name);
	const json = await rebuild(timing);
	return send(json, `view;desc=built, ${timing.header()}`);
}

// A repo for the dashboard: a snapshot of its claims and votes, read from Git.
app.get("/repos/:owner/:name", async (c) => {
	const repo = await routeRepo(c, "read");
	return keptView(c, `repo:${repo.id}`, "snapshot", 20_000, (timing) => repoSnapshot({ ...toolContext(c.env, c.get("principal")), timing }, repo.id));
});
// Who the caller is in a repo: its full name, id (the live feed's key), and what they may do.
app.get("/repos/:owner/:name/access", async (c) => {
	const repo = await routeRepo(c, "read");
	const meta = c.env.DB ? await new OrgStore(c.env.DB).repoById(repo.id) : null;
	return c.json({ ...repo, visibility: meta?.visibility ?? null });
});
// A person's vote on a change, from the dashboard: stamped with their verified identity.
app.post("/repos/:owner/:name/changes/:change/votes", async (c) => {
	const actor = c.get("principal") ?? fail(401, "no identity");
	if (!isPerson(actor)) fail(403, "a vote from the dashboard is a person's: agents vote through MCP");
	const repo = await routeRepo(c, "review");
	const { role, verdict, evidence } = await jsonArgs(c);
	return c.json(await voteAsPerson(toolContext(c.env, actor), repo.id, c.req.param("change"), { role: String(role ?? ""), verdict: verdict as "approve" | "reject", evidence: String(evidence ?? "") }, byOf(actor)));
});
app.get("/repos/:owner/:name/changes/:change", async (c) => {
	const repo = await routeRepo(c, "read");
	const change = c.req.param("change");
	return keptView(c, `repo:${repo.id}`, `change:${change}`, 60_000, (timing) => changeHistory({ ...toolContext(c.env, c.get("principal")), timing }, repo.id, change));
});
// The warmth of a repo's check containers: whether each lane runs, and when it last warmed.
app.get("/repos/:owner/:name/lanes", async (c) => {
	const repo = await routeRepo(c, "read");
	return c.json(await c.env.GATE.getByName(`repo:${repo.id}`).lanes(repo.id));
});
app.get("/repos/:owner/:name/audit", async (c) => {
	const repo = await routeRepo(c, "read");
	return keptView(c, `repo:${repo.id}`, "audit", 5 * 60_000, (timing) => repoAudit({ ...toolContext(c.env, c.get("principal")), timing }, repo.id));
});
app.get("/repos/:owner/:name/builders/:change", async (c) => {
	const repo = await routeRepo(c, "read");
	return c.json(await c.env.BUILDER.getByName(changeRepoName(repo.id, c.req.param("change"))).state());
});
// A hosted reviewer's state, by the commit it reviews (the vote's commit) and its role.
app.get("/repos/:owner/:name/reviewers/:change/:head/:role", async (c) => {
	const repo = await routeRepo(c, "read");
	const { change, head, role } = c.req.param();
	return c.json(await c.env.REVIEWER.getByName(reviewerName(changeRepoName(repo.id, change), role, head)).state());
});
// Live updates for a repo: a WebSocket on its feed, which pings when its records change.
app.get("/repos/:owner/:name/live", async (c) => {
	const repo = await routeRepo(c, "read");
	return c.env.LIVE.getByName(`repo:${repo.id}`).fetch(c.req.raw);
});
// A repo's settings: private or public (admins of the repo).
app.patch("/repos/:owner/:name", async (c) => {
	const repo = await routeRepo(c, "admin");
	const { visibility } = await jsonArgs(c);
	const orgs = new OrgStore(c.env.DB);
	if (visibility !== undefined) await orgs.setVisibility(repo.id, visibility as "private" | "public");
	return c.json(await orgs.repoById(repo.id));
});
// Collaborators: people given a level in one repo (admins of the repo).
app.get("/repos/:owner/:name/collaborators", async (c) => {
	const repo = await routeRepo(c, "admin");
	return c.json(await new OrgStore(c.env.DB).collaborators(repo.id));
});
app.put("/repos/:owner/:name/collaborators/:handle", async (c) => {
	const repo = await routeRepo(c, "admin");
	const { permission } = await jsonArgs(c);
	await new OrgStore(c.env.DB).setCollaborator(repo.id, c.req.param("handle"), permission as Level);
	return c.json({ collaborator: c.req.param("handle"), permission });
});
app.delete("/repos/:owner/:name/collaborators/:handle", async (c) => {
	const repo = await routeRepo(c, "admin");
	await new OrgStore(c.env.DB).removeCollaborator(repo.id, c.req.param("handle"));
	return c.json({ removed: c.req.param("handle") });
});

/** One MCP request (stateless JSON-RPC over HTTP) from a caller: Access, an agent token, or an OAuth grant. */
async function mcpResponse(request: Request, env: Env, principal: Principal | undefined) {
	const body = await request.json().catch(() => null);
	if (body === null) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
	const result = await handleMcpBody(body, {
		toolkit: toolContext(env, principal, request.headers.get("X-GitHive-Agent-Key") ?? undefined),
		resolveRepo: (repo, tool, args) => resolveRepo(env, principal, repo, toolLevel(tool, args)),
	});
	return result === null ? new Response(null, { status: 202 }) : Response.json(result);
}

// The MCP front door, for agents from anywhere.
app.post("/mcp", (c) => mcpResponse(c.req.raw, c.env, c.get("principal")));
app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

// The dashboard's list of repos in one read: every repo with its summary.
// Summaries older than the repo's last activity are counted again in the
// background, a few per request.
app.get("/summaries", async (c) => {
	const index = repoIndex(c.env);
	const [listed, visible] = await Promise.all([index.summaries(), visibleRepos(c.env, c.get("principal"))]);
	const summaries = new Map(listed.repos.map((r) => [r.repo, r]));
	// Every repo the caller can see, named as people name it, with its counts if GitHive has started on it.
	const repos = visible.map((r) => ({ repo: r.fullName, id: r.id, since: summaries.get(r.id)?.since ?? r.createdAt, summary: summaries.get(r.id)?.summary ?? null, started: summaries.has(r.id) }));
	const now = new Date().toISOString();
	// The most recently active first: those are the rows people look at.
	const stale = repos
		.filter((r) => r.started)
		.filter((r) => !r.summary?.countedAt || (r.summary.lastActivity ?? "") > r.summary.countedAt)
		.sort((a, b) => (b.summary?.lastActivity ?? b.since).localeCompare(a.summary?.lastActivity ?? a.since))
		.slice(0, 3);
	const ctx = toolContext(c.env, c.get("principal"));
	c.executionCtx.waitUntil(
		Promise.allSettled(
			stale.map(async (r) => {
				const open = await openCount(ctx, r.id).catch(() => null);
				await index.summarize(`repo:${r.id}`, open === null ? { countedAt: now } : { open, countedAt: now });
			}),
		),
	);
	return c.json({ repos: repos.map(({ started: _started, ...r }) => r) });
});

/**
 * The repos a caller can see: for a person or their agent, their orgs',
 * their collaborations and public ones; for an Access admin, every repo in an
 * org and every project repo that isn't in one yet (as _/<id>).
 */
async function visibleRepos(env: Env, principal: Principal | undefined) {
	if (!principal) return [];
	const orgs = env.DB ? new OrgStore(env.DB) : null;
	if (principal.kind !== "access") return orgs ? await orgs.visibleRepos(principal.user.id) : [];
	const inOrgs = orgs ? await orgs.allRepos() : [];
	const ids = new Set(inOrgs.map((r) => r.id));
	const loose = (await listRepoNames(env.ARTIFACTS)).filter((n) => isProject(n) && !ids.has(n)).map((id) => ({ id, org: "_", name: id, fullName: `_/${id}`, visibility: "private" as const, createdAt: "" }));
	return [...inOrgs, ...loose];
}

/** Not a project: an agent's fork, or a repo's claim records. */
const isProject = (name: string) => !name.startsWith("fork--") && !name.startsWith("records--");

/** A deleted project's tokens and kept dashboard views go with it, so a new repo by its name starts clean. */
async function forgetRepo(env: Env, repo: string) {
	await Promise.resolve()
		.then(() => Promise.all([env.TOKENS?.getByName(repo).clear(), env.LIVE?.getByName(`repo:${repo}`).clearViews()]))
		.catch((err) => console.error(`forgetting ${repo}'s tokens and views failed`, String(err)));
}

app.get("/repos", async (c) => {
	const repos = await visibleRepos(c.env, c.get("principal"));
	return c.json(repos.map((r) => ({ name: r.fullName, id: r.id, visibility: r.visibility })).sort((a, b) => a.name.localeCompare(b.name)));
});

// Older repos that aren't in an org yet, and taking one into an org as it is (records and all): Access admins.
app.get("/admin/repos", async (c) => {
	requireAccess(c);
	return c.json((await visibleRepos(c.env, c.get("principal"))).filter((r) => r.org === "_").map((r) => r.id));
});
app.post("/admin/repos/:id/adopt", async (c) => {
	requireAccess(c);
	const { owner, name } = await jsonArgs(c);
	const orgs = new OrgStore(c.env.DB);
	// A person's own namespace may not exist yet if they haven't been back since orgs arrived.
	const person = await orgs.userByHandle(String(owner ?? ""));
	if (person && !(await orgs.org(person.handle))) await orgs.personalOrg(person);
	const org = await orgs.orgOrFail(String(owner ?? ""));
	return c.json(await orgs.addRepo(org, String(name ?? c.req.param("id")), null, { id: c.req.param("id") }), 201);
});

// Bench only (BENCH_WIPE, set in wrangler.bench.jsonc and never on production):
// delete every repo in the namespace, a batch per call (a request can make only
// so many subrequests), and forget every repo the dashboard lists.
// Call again until nothing remains.
const WIPE_CONFIRMATION = "delete every repo in the bench namespace";
const WIPE_BATCH = 400;
const WIPE_PARALLEL = 8;
app.post("/admin/wipe", async (c) => {
	if ((c.env as unknown as { BENCH_WIPE?: string }).BENCH_WIPE !== "allowed") return c.json({ error: "not available here" }, 404);
	if (c.get("principal")?.kind !== "access") return c.json({ error: "only through Cloudflare Access" }, 403);
	const { confirm, batch: size } = await jsonArgs(c);
	if (confirm !== WIPE_CONFIRMATION) return c.json({ error: `confirm with "${WIPE_CONFIRMATION}"` }, 400);
	await repoIndex(c.env).clear();
	const names = await listRepoNames(c.env.ARTIFACTS);
	const batch = names.slice(0, typeof size === "number" && size > 0 ? Math.min(size, WIPE_BATCH) : WIPE_BATCH);
	const failed: string[] = [];
	// A few at a time: one by one, a batch outlasts the caller's patience.
	for (let i = 0; i < batch.length; i += WIPE_PARALLEL)
		await Promise.all(batch.slice(i, i + WIPE_PARALLEL).map((name) => retryTransient(() => c.env.ARTIFACTS.delete(name)).then(() => (isProject(name) ? forgetRepo(c.env, name) : undefined)).catch(() => failed.push(name))));
	console.log("bench wipe", JSON.stringify({ deleted: batch.length - failed.length, failed: failed.length, remaining: names.length - batch.length }));
	return c.json({ deleted: batch.length - failed.length, failed, remaining: names.length - batch.length + failed.length });
});

// Live updates: a page opens a WebSocket on its repo's feed ("repo:<repo>") and refreshes when pinged.
app.get("/live/:key", async (c) => {
	requireAccess(c);
	const key = c.req.param("key");
	if (!/^repo:[A-Za-z0-9._-]+$/.test(key)) return c.json({ error: "not a feed" }, 400);
	return c.env.LIVE.getByName(key).fetch(c.req.raw);
});

// Browse a repo's code: its files, and one file's text, at a branch or commit (the repo's default branch if none).
app.get("/repos/:owner/:name/tree", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, (await routeRepo(c, "read")).id, "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await listTree(remote, ref)) });
});
app.get("/repos/:owner/:name/file", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, (await routeRepo(c, "read")).id, "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await readFile(remote, ref, c.req.query("path") ?? "")) });
});

// Delete a project repo for good, with its tokens and kept views.
app.delete("/repos/:owner/:name", async (c) => {
	const repo = await routeRepo(c, "admin");
	const deleted = await retryTransient(() => c.env.ARTIFACTS.delete(repo.id));
	if (!deleted) return c.json({ error: `no repo ${repo.fullName}` }, 404);
	if (c.env.DB) await new OrgStore(c.env.DB).removeRepo(repo.id);
	await forgetRepo(c.env, repo.id);
	console.log("repo deleted", repo.id);
	return c.json({ deleted: repo.fullName });
});

// Everything that isn't an API route is the dashboard.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * MCP over OAuth, on the public origin only (PUBLIC_ORIGIN: githive.app, or
 * bench.githive.app): a client discovers GitHive's authorization server from
 * /mcp's 401, registers, and sends a person to /authorize. Every call with a
 * grant checks its agent is still active. The Access hostnames are served as
 * before, and an agent token on /mcp needs no OAuth.
 */
const providers = new Map<string, OAuthProvider<Env>>();
function oauthFor(origin: string) {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: {
				async fetch(request, env, ctx) {
					const props = (ctx as unknown as { props?: { userId?: string; agentId?: string } }).props;
					const found = props?.agentId ? await new IdentityStore(env.DB).activeAgent(props.agentId) : null;
					if (!found || found.user.id !== props?.userId) return Response.json({ error: "this connection's agent was revoked: connect again" }, { status: 401 });
					return mcpResponse(request, env, { kind: "agent", ...found });
				},
			},
			defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			clientRegistrationEndpoint: "/oauth/register",
			clientIdMetadataDocumentEnabled: true,
			scopesSupported: ["mcp"],
			requiredScopes: ["mcp"],
			resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "GitHive" },
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const origin = (env as unknown as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN;
		const url = new URL(request.url);
		if (!origin || !env.OAUTH_KV || url.origin !== origin) return app.fetch(request, env, ctx);
		if (url.pathname === "/mcp" && /^Bearer\s+ghv_/i.test(request.headers.get("Authorization") ?? "")) return app.fetch(request, env, ctx);
		return oauthFor(origin).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
