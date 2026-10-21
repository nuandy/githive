import { Hono } from "hono";
import { identityStore, resolvePrincipal } from "./auth/principal";
import { type SignInExtras, authRoutes } from "./auth/routes";
import { authorize } from "./auth/authorize";
import { orgRoutes } from "./auth/org-routes";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { isFailure, statusOf } from "./errors";
import { type HouseModel, useHouseModel } from "./models/payer";
import { notePushEvents } from "./push-events";
import { awarenessHandOff } from "./footprint-cache";
import { countingRequests, describeCounts } from "./git-http";
import { adminRoutes } from "./routes/admin";
import { dashboardRoutes } from "./routes/dashboard";
import { hostedAgentRoutes } from "./routes/hosted-agents";
import { mcpResponse, mcpRoutes } from "./routes/mcp";
import { modelSettingsRoutes } from "./routes/model-settings";
import { repoRoutes } from "./routes/repos";
import { siteRoutes } from "./routes/site";
import type { AppEnv } from "./routes/shared";

// GitHive's Worker, as a function: sign-in and request logging around every route, the route groups in src/routes,
// and MCP over OAuth. src/index.ts is GitHive on its own; a Worker that adds to it calls githive() with its options.

/** What a Worker built on GitHive adds to it. */
export interface GitHiveOptions {
	/** Route groups of its own, after GitHive's and before the dashboard's files. */
	routes?: Array<(app: Hono<AppEnv>) => void>;
	/**
	 * Where its dashboard's files are, when it has one: every path no route answers is read from there, and a repo's
	 * API address opened in a browser goes to the repo's page.
	 */
	dashboard?: (env: Env) => Fetcher;
	/** Paths that answer without signing in, by prefix: their routes check for themselves. */
	publicPrefixes?: string[];
	/** Lines added to the list of routes /api gives. */
	apiRoutes?: string[];
	/** The model a GitHive's own runs use. Without one, hosted agents start only on a person's own. */
	houseModel?: HouseModel;
	signInExtras?: SignInExtras;
}

// /settings/model shows people signed out how to sign in to set their model (see routes/model-settings.ts).
const PUBLIC_PATHS = ["/", "/authorize", "/settings/model"];
const PUBLIC_PREFIXES = ["/auth/", "/.well-known/", "/site/"];

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** A read of one repo (/repos/:owner/:name/...). Signed out, it answers only for a public repo (see access-control). */
const REPO_READ = /^\/repos\/[^/]+\/[^/]+(\/|$)/;

/** Served without signing in: the front page, sign-in, OAuth, reads of repos, and the Worker's own public prefixes. */
function isPublic(request: Request, path: string, prefixes: string[]) {
	if (PUBLIC_PATHS.includes(path)) return true;
	if (SAFE_METHODS.includes(request.method) && REPO_READ.test(path)) return true;
	return prefixes.some((prefix) => path.startsWith(prefix));
}

/** A write whose Origin isn't this site, which a signed-in person's cookie must not authorize. */
function isCrossSiteWrite(request: Request) {
	if (SAFE_METHODS.includes(request.method)) return false;
	return request.headers.get("Origin") !== new URL(request.url).origin;
}

/** Around every route: no caching of answers, who's asking, and what each request asked of Git and Artifacts. */
function middleware(app: Hono<AppEnv>, publicPrefixes: string[]) {
	// The API's answers change from one read to the next, and some take seconds to make, so browsers mustn't keep them:
	// a kept answer is a cache entry that every tab's next read of that URL waits on. Answers that set their own caching,
	// and the dashboard's files, are left as they are.
	app.use("*", async (c, next) => {
		await next();
		const json = c.res.headers.get("Content-Type")?.startsWith("application/json");
		if (!json || c.res.headers.has("Cache-Control")) return;
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set("Cache-Control", "no-store");
	});

	// Authenticate before routing: Access, an agent token, or a session cookie (see auth/principal.ts).
	app.use("*", async (c, next) => {
		const principal = await resolvePrincipal(c.req.raw, c.env);
		if (principal) c.set("principal", principal);
		else if (!isPublic(c.req.raw, c.req.path, publicPrefixes))
			return c.json({ error: "sign in to GitHive first" }, 401);
		// A session cookie rides along with any request to this site, so a write on one must come from this site's own
		// pages.
		if (principal?.kind === "user" && isCrossSiteWrite(c.req.raw))
			return c.json({ error: "refused: a signed-in write must come from GitHive's own pages" }, 403);
		await next();
	});

	// Log what each request asked of Git and Artifacts. MCP calls log their own, by tool (see mcp.ts).
	app.use("*", async (c, next) => {
		const counting = countingRequests(() => next());
		try {
			await counting.done;
		} finally {
			const counts = describeCounts(undefined, counting.requests, counting.artifacts);
			if (counts) console.log(`http ${c.req.method} ${c.req.routePath} ${counts}`);
		}
	});

	app.onError((err, c) => {
		const { status, message } = statusOf(err);
		if (status < 500) return c.json({ error: message }, status as 400);
		// Text from underneath (D1, Artifacts, Cloudflare's APIs) isn't the client's to read: it's logged under an id
		// the reply gives instead.
		const id = crypto.randomUUID().slice(0, 8);
		console.error(`API error ${id}`, err);
		const said = isFailure(err) ? message : `GitHive failed unexpectedly (error ${id}); try again`;
		return c.json({ error: said }, status as 500);
	});
}

/** What /api lists. */
const API_ROUTES = [
	"POST /mcp         (the MCP front door: JSON-RPC over HTTP; repo is <owner>/<name>)",
	"GET  /me          (who you are)",
	"GET  /auth/:provider  (sign in with github or google)",
	"GET|POST /me/agents, DELETE /me/agents/:id, POST /me/agents/:id/tokens, DELETE " +
		"/me/tokens/:id  (your agents and their tokens)",
	"GET|DELETE /me/connections  (MCP clients connected as your agents)",
	"GET|POST /orgs, GET|PATCH /orgs/:org  (your orgs; one's repos, members and teams)",
	"POST /orgs/:org/members {email, role}, PATCH|DELETE /orgs/:org/members/:handle, DELETE " +
		"/orgs/:org/invites/:email",
	"POST /orgs/:org/teams {slug}, DELETE /orgs/:org/teams/:team, PUT|DELETE /orgs/:org/teams/:team/members/:handle",
	"GET  /repos       (the repos you can see)",
	"POST /repos {owner, name, import_url? (import_token? for a private repo) | copy_from?, visibility?}  (a new repo)",
	"GET  /summaries   (every repo you can see, with its counts)",
	"GET  /repos/:owner/:name  (claims and votes, from Git); /access (your permission)",
	"GET  /repos/:owner/:name/changes/:change  (one change's history)",
	"POST /repos/:owner/:name/changes/:change/votes {role, verdict, evidence}  (a person's vote; review)",
	"GET  /repos/:owner/:name/audit | /landing?branch= | /tree?ref= | /file?path=&ref= | /live (WebSocket)",
	"GET  /site/:owner/:name/[@:change/]path  (a public repo's static site: its default branch, or a change)",
	"PATCH /repos/:owner/:name {visibility}, GET|PUT|DELETE /repos/:owner/:name/collaborators[/:handle]  (admin)",
	"DELETE /repos/:owner/:name  (admin)",
	"Access admins: POST /repos/import, /repos/_/<id>/..., GET /admin/repos, POST " +
		"/admin/repos/:id/adopt {owner, name}, GET|POST|DELETE /admin/invites",
];

/** A repo's API address opened in a browser, as people paste it, goes to its page on the dashboard. */
function repoPages(app: Hono<AppEnv>) {
	// The dashboard's own reads and scripts aren't page loads, so they still get the JSON.
	app.get("/repos/:owner/:name", async (c, next) => {
		if (c.req.header("Sec-Fetch-Mode") !== "navigate" || c.req.header("Sec-Fetch-Dest") !== "document") return next();
		const repo = [c.req.param("owner"), c.req.param("name")].map(encodeURIComponent).join("/");
		return c.redirect(`/#/repos/${repo}`, 302);
	});
}

/** GitHive's routes, then the Worker's own, then the dashboard's files if it has a dashboard. */
function appFor(options: GitHiveOptions) {
	const app = new Hono<AppEnv>();
	middleware(app, [...PUBLIC_PREFIXES, ...(options.publicPrefixes ?? [])]);

	authRoutes(app, options.signInExtras);
	orgRoutes(app);
	modelSettingsRoutes(app);
	// Where an MCP client sends a person to connect it as one of their agents (OAuth).
	app.on(["GET", "POST"], "/authorize", authorize);
	app.get("/api", (c) => c.json({ name: "githive", routes: [...API_ROUTES, ...(options.apiRoutes ?? [])] }));

	const { dashboard } = options;
	if (dashboard) repoPages(app);

	repoRoutes(app);
	dashboardRoutes(app);
	hostedAgentRoutes(app);
	siteRoutes(app);
	mcpRoutes(app);
	adminRoutes(app);
	for (const routes of options.routes ?? []) routes(app);

	if (dashboard) app.get("*", (c) => dashboard(c.env).fetch(c.req.raw));
	else app.notFound((c) => c.json({ error: `no route ${c.req.method} ${c.req.path}: GET /api lists them` }, 404));
	return app;
}

/**
 * MCP over OAuth, on the public origin only. A client finds the authorization server from /mcp's 401, registers, and
 * sends a person to /authorize. Every call with a grant checks that its agent is still active.
 */
function oauthFor(app: Hono<AppEnv>, providers: Map<string, OAuthProvider<Env>>, origin: string) {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: {
				async fetch(request, env, ctx) {
					const props = (ctx as unknown as { props?: { userId?: string; agentId?: string } }).props;
					const found = props?.agentId ? await identityStore(env)?.activeAgent(props.agentId) : null;
					if (!found || found.user.id !== props?.userId)
						return Response.json({ error: "this connection's agent was revoked: connect again" }, { status: 401 });
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

/** A GitHive Worker: its routes, MCP over OAuth on the public origin, and Artifacts' push events. */
export function githive(options: GitHiveOptions = {}) {
	if (options.houseModel) useHouseModel(options.houseModel);
	const app = appFor(options);
	const providers = new Map<string, OAuthProvider<Env>>();
	return {
		fetch(request: Request, env: Env, ctx: ExecutionContext) {
			const origin = (env as unknown as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN;
			const url = new URL(request.url);
			if (!origin || !env.OAUTH_KV || url.origin !== origin) return app.fetch(request, env, ctx);
			if (url.pathname === "/mcp" && /^Bearer\s+ghv_/i.test(request.headers.get("Authorization") ?? ""))
				return app.fetch(request, env, ctx);
			return oauthFor(app, providers, origin).fetch(request, env, ctx);
		},
		// Artifacts' push events, so changes' heads are known without reading forks, and awareness follows the code.
		queue: (batch: MessageBatch<unknown>, env: Env) => notePushEvents(batch, env, awarenessHandOff(env)),
	} satisfies ExportedHandler<Env>;
}
