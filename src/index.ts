import { type Context, Hono } from "hono";
import { type Principal, agentNameOf, byOf, isPerson, resolvePrincipal } from "./auth/principal";
import { authRoutes } from "./auth/routes";
import { authorize } from "./auth/authorize";
import { IdentityStore } from "./auth/store";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { forkAndWait, listRepoNames, remoteFor, reviewerName } from "./artifacts";
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
// Where an MCP client sends a person to connect it as one of their agents (OAuth).
app.on(["GET", "POST"], "/authorize", authorize);

app.get("/api", (c) =>
	c.json({
		name: "githive",
		routes: [
			"GET  /            dashboard",
			"POST /mcp         (the MCP front door: JSON-RPC over HTTP)",
			"GET  /repos       (project repos)",
			"POST /repos/import {url, name, branch?}",
			"POST /repos/:repo/copy {name}  (a new repo from another's default branch)",
			"GET  /repos/:repo/tree?ref=  (every file at a branch or commit)",
			"GET  /repos/:repo/file?path=&ref=  (one file's text)",
			"DELETE /repos/:repo",
			"GET  /summaries   (every repo with its counts, for the dashboard's list)",
			"GET  /repos/:repo  (claims and votes, from Git)",
			"GET  /repos/:repo/changes/:change  (one change's history)",
			"POST /repos/:repo/changes/:change/votes {role, verdict, evidence}  (a person's vote)",
			"GET  /repos/:repo/audit  (replays the records: merges and broken conventions)",
			"GET  /repos/:repo/lanes  (the check containers' warmth)",
			"GET  /auth/:provider  (sign in with github or google)",
			"GET  /me          (who you are)",
			"GET|POST /me/agents, DELETE /me/agents/:id, POST /me/agents/:id/tokens, DELETE /me/tokens/:id  (your agents and their tokens)",
			"GET|DELETE /me/connections  (MCP clients connected as your agents)",
			"GET|POST|DELETE /admin/invites  (who may sign in; admins, through Access)",
		],
	}),
);

app.post("/repos/import", async (c) => {
	const { url, name, branch } = await c.req.json<{ url: string; name: string; branch?: string }>();
	const imported = await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } }));
	return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
});

// A new project repo copied from another (its default branch): seconds, where importing a big project takes a minute or more.
app.post("/repos/:repo/copy", async (c) => {
	const { name } = await c.req.json<{ name: string }>();
	if (!name || !isProject(name)) fail(400, "name the new repo: not a fork's or a records repo's name");
	const copied = await forkAndWait(c.env.ARTIFACTS, c.req.param("repo"), name, `A copy of ${c.req.param("repo")}`);
	return c.json({ name, remote: copied.remote });
});

/** GitHive's tools for this caller (see docs/design.md): stateless, Git only. A signed-in agent needs no key. */
const toolContext = (env: Env, principal: Principal | undefined, agentKey?: string): ToolContext => {
	const agent = principal && agentNameOf(principal);
	return toolContextFor(env, principal ? byOf(principal) : undefined, agent ? { agent } : agentKey ? { agentKey } : {});
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
app.get("/repos/:repo", async (c) => {
	const repo = c.req.param("repo");
	return keptView(c, `repo:${repo}`, "snapshot", 20_000, (timing) => repoSnapshot({ ...toolContext(c.env, c.get("principal")), timing }, repo));
});
// A person's vote on a change, from the dashboard: stamped with their verified identity.
app.post("/repos/:repo/changes/:change/votes", async (c) => {
	const actor = c.get("principal") ?? fail(401, "no identity");
	if (!isPerson(actor)) fail(403, "a vote from the dashboard is a person's: agents vote through MCP");
	const { role, verdict, evidence } = await jsonArgs(c);
	const repo = c.req.param("repo");
	return c.json(await voteAsPerson(toolContext(c.env, actor), repo, c.req.param("change"), { role: String(role ?? ""), verdict: verdict as "approve" | "reject", evidence: String(evidence ?? "") }, byOf(actor)));
});
app.get("/repos/:repo/changes/:change", async (c) => {
	const { repo, change } = c.req.param();
	return keptView(c, `repo:${repo}`, `change:${change}`, 60_000, (timing) => changeHistory({ ...toolContext(c.env, c.get("principal")), timing }, repo, change));
});
// The warmth of a repo's check containers: whether each lane runs, and when it last warmed.
app.get("/repos/:repo/lanes", async (c) => c.json(await c.env.GATE.getByName(`repo:${c.req.param("repo")}`).lanes(c.req.param("repo"))));
app.get("/repos/:repo/audit", async (c) => {
	const repo = c.req.param("repo");
	return keptView(c, `repo:${repo}`, "audit", 5 * 60_000, (timing) => repoAudit({ ...toolContext(c.env, c.get("principal")), timing }, repo));
});
app.get("/repos/:repo/builders/:change", async (c) => c.json(await c.env.BUILDER.getByName(changeRepoName(c.req.param("repo"), c.req.param("change"))).state()));
// A hosted reviewer's state, by the commit it reviews (the vote's commit) and its role.
app.get("/repos/:repo/reviewers/:change/:head/:role", async (c) => {
	const { repo, change, head, role } = c.req.param();
	return c.json(await c.env.REVIEWER.getByName(reviewerName(changeRepoName(repo, change), role, head)).state());
});

/** One MCP request (stateless JSON-RPC over HTTP) from a caller: Access, an agent token, or an OAuth grant. */
async function mcpResponse(request: Request, env: Env, principal: Principal | undefined) {
	const body = await request.json().catch(() => null);
	if (body === null) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
	const result = await handleMcpBody(body, { toolkit: toolContext(env, principal, request.headers.get("X-GitHive-Agent-Key") ?? undefined) });
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
	const listed = await index.summaries();
	const now = new Date().toISOString();
	// The most recently active first: those are the rows people look at.
	const stale = listed.repos
		.filter((r) => !r.summary?.countedAt || (r.summary.lastActivity ?? "") > r.summary.countedAt)
		.sort((a, b) => (b.summary?.lastActivity ?? b.since).localeCompare(a.summary?.lastActivity ?? a.since))
		.slice(0, 3);
	const ctx = toolContext(c.env, c.get("principal"));
	c.executionCtx.waitUntil(
		Promise.allSettled(
			stale.map(async (r) => {
				const open = await openCount(ctx, r.repo).catch(() => null);
				await index.summarize(`repo:${r.repo}`, open === null ? { countedAt: now } : { open, countedAt: now });
			}),
		),
	);
	return c.json({ repos: listed.repos });
});

/** Not a project: an agent's fork, or a repo's claim records. */
const isProject = (name: string) => !name.startsWith("fork--") && !name.startsWith("records--");

/** A deleted project's tokens and kept dashboard views go with it, so a new repo by its name starts clean. */
async function forgetRepo(env: Env, repo: string) {
	await Promise.resolve()
		.then(() => Promise.all([env.TOKENS?.getByName(repo).clear(), env.LIVE?.getByName(`repo:${repo}`).clearViews()]))
		.catch((err) => console.error(`forgetting ${repo}'s tokens and views failed`, String(err)));
}

app.get("/repos", async (c) => {
	const names = (await listRepoNames(c.env.ARTIFACTS)).filter(isProject);
	return c.json(names.sort().map((name) => ({ name })));
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
	const key = c.req.param("key");
	if (!/^repo:[A-Za-z0-9._-]+$/.test(key)) return c.json({ error: "not a feed" }, 400);
	return c.env.LIVE.getByName(key).fetch(c.req.raw);
});

// Browse a repo's code: its files, and one file's text, at a branch or commit (the repo's default branch if none).
app.get("/repos/:repo/tree", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, c.req.param("repo"), "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await listTree(remote, ref)) });
});
app.get("/repos/:repo/file", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, c.req.param("repo"), "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await readFile(remote, ref, c.req.query("path") ?? "")) });
});

// Delete a project repo for good, with its tokens and kept views.
app.delete("/repos/:repo", async (c) => {
	const repo = c.req.param("repo");
	const deleted = await retryTransient(() => c.env.ARTIFACTS.delete(repo));
	if (!deleted) return c.json({ error: `no repo ${repo}` }, 404);
	await forgetRepo(c.env, repo);
	console.log("repo deleted", repo);
	return c.json({ deleted: repo });
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
