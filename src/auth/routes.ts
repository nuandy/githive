import { Hono } from "hono";
import { AgentLimitStore, limitsFrom } from "./agent-limits";
import { type Principal, SESSION_COOKIE, cookie, describe, identityStore } from "./principal";
import { PROVIDERS, type ProviderConfig, type ProviderName, isProvider, pkceChallenge } from "./providers";
import { codeInviteLabel, inviteCodeMatches, inviteCodeOf } from "./invite-code";
import { HOUSE, hasModel } from "../models/payer";
import { OrgStore } from "./orgs";
import { type IdentityStore, type ProviderProfile, SESSION_DAYS, normalizeEmail, randomSecret } from "./store";
import { fail } from "../errors";

// Sign-in with GitHub or Google, and a signed-in person's own agents, tokens and connected MCP clients.
// Admins behind Access manage invitations here too. Where an invite code is set, signing in with it invites the
// person (see invite-code.ts).

export type AuthEnv = { Bindings: Env; Variables: { principal?: Principal } };

const SIGNIN_COOKIE = "__Host-githive_signin";

const cookieHeader = (name: string, value: string, maxAgeSeconds: number) =>
	`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

/** Accepts only a path on this site, never another origin ("//evil", "https://…"). */
export function safeReturn(value: string | undefined | null): string {
	if (!value?.startsWith("/")) return "/";
	if (value.startsWith("//")) return "/";
	// Browsers drop tabs and newlines from addresses and read "\\" as "/", so "/\t/evil" would leave the site.
	if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return "/";
	const here = "https://githive.invalid";
	return new URL(value, here).origin === here ? value : "/";
}

function providerConfig(env: Env, name: ProviderName): ProviderConfig | null {
	const e = env as unknown as Record<string, string | undefined>;
	const id = e[`${name.toUpperCase()}_CLIENT_ID`];
	const secret = e[`${name.toUpperCase()}_CLIENT_SECRET`];
	return id && secret ? { clientId: id, clientSecret: secret } : null;
}

const store = (env: Env): IdentityStore =>
	identityStore(env) ??
	(() => {
		fail(503, "sign-in isn't set up here (no identity database)");
	})();

/** The signed-in person (not an agent, not an Access caller), or a 401. */
const signedInUser = (principal: Principal | undefined) => {
	if (principal?.kind !== "user") fail(401, "sign in to GitHive first");
	return principal.user;
};

/** More for the sign-in page to show, added to what /auth/providers answers. */
export type SignInExtras = (env: Env) => Record<string, unknown>;

export function authRoutes(app: Hono<AuthEnv>, signInExtras?: SignInExtras) {
	signInRoutes(app, signInExtras);
	accountRoutes(app);
	adminRoutes(app);
}

type PendingSignIn = { provider: string; state: string; verifier: string; return: string; invite?: string };

/** The sign-in this browser started, from its cookie, or null if there's none or it can't be read. */
function pendingSignIn(request: Request): PendingSignIn | null {
	try {
		return JSON.parse(cookie(request, SIGNIN_COOKIE) ?? "null");
	} catch {
		return null;
	}
}

/**
 * Signs in the person the provider vouched for, with their personal org and any org invitations, and returns a
 * new session id, or null when they aren't invited. With the right invite code, they're invited by it.
 */
async function startSession(env: Env, profile: ProviderProfile, withInviteCode: boolean) {
	const ids = store(env);
	let signed = await ids.signIn(profile);
	const code = inviteCodeOf(env);
	if ("refused" in signed && withInviteCode && code) {
		await ids.invite(profile.email, await codeInviteLabel(code));
		signed = await ids.signIn(profile);
	}
	if ("refused" in signed) return null;
	const orgs = new OrgStore(env.DB);
	await orgs.personalOrg(signed.user);
	await orgs.acceptInvites(signed.user);
	return ids.createSession(signed.user.id);
}

/** Signing in with GitHub or Google, and out. */
function signInRoutes(app: Hono<AuthEnv>, signInExtras?: SignInExtras) {
	app.get("/auth/providers", (c) =>
		c.json({
			providers: (["github", "google"] as const).filter((p) => providerConfig(c.env, p)),
			inviteCode: !!inviteCodeOf(c.env),
			...signInExtras?.(c.env),
		}),
	);

	// Sends the person to the provider. The state and PKCE verifier wait in a short-lived cookie.
	app.get("/auth/:provider", async (c) => {
		const name = c.req.param("provider");
		if (!isProvider(name)) return c.json({ error: `no sign-in with ${name}` }, 404);
		const config = providerConfig(c.env, name);
		if (!config) return c.json({ error: `sign-in with ${name} isn't set up here` }, 404);
		const state = randomSecret(24);
		const verifier = randomSecret(48);
		const origin = new URL(c.req.url).origin;
		const started: PendingSignIn = { provider: name, state, verifier, return: safeReturn(c.req.query("return")) };
		const invite = c.req.query("invite")?.trim().slice(0, 200);
		if (invite) started.invite = invite;
		const pending = JSON.stringify(started);
		c.header("Set-Cookie", cookieHeader(SIGNIN_COOKIE, pending, 600));
		return c.redirect(
			PROVIDERS[name].authorizeUrl({
				clientId: config.clientId,
				redirectUri: `${origin}/auth/${name}/callback`,
				state,
				challenge: await pkceChallenge(verifier),
			}),
			302,
		);
	});

	// The provider's callback checks the state, learns who signed in, and starts a session.
	app.get("/auth/:provider/callback", async (c) => {
		const name = c.req.param("provider");
		// A request to join comes back with the email it's noted under, in the fragment: the browser keeps that to
		// itself, so the address never reaches a request log.
		const back = (error: string, noted?: string) => {
			c.header("Set-Cookie", cookieHeader(SIGNIN_COOKIE, "", 0));
			const fragment = noted ? `#signin-as=${encodeURIComponent(noted)}` : "";
			return c.redirect(`/?signin_error=${encodeURIComponent(error)}${fragment}`, 302);
		};
		if (!isProvider(name)) return c.json({ error: `no sign-in with ${name}` }, 404);
		const config = providerConfig(c.env, name);
		if (!config) return c.json({ error: `sign-in with ${name} isn't set up here` }, 404);
		const pending = pendingSignIn(c.req.raw);
		const code = c.req.query("code");
		if (c.req.query("error")) return back("cancelled");
		if (!pending || pending.provider !== name || !code || c.req.query("state") !== pending.state)
			return back("expired");
		let profile;
		try {
			profile = await PROVIDERS[name].profile({
				config,
				code,
				redirectUri: `${new URL(c.req.url).origin}/auth/${name}/callback`,
				verifier: pending.verifier,
			});
		} catch (err) {
			// Log the provider's error for debugging, never the code or a secret.
			console.error(`sign-in with ${name} failed`, err instanceof Error ? err.message : String(err));
			return back(/\[403\]/.test(String(err)) ? "unverified-email" : "provider-failed");
		}
		const withInviteCode = await inviteCodeMatches(inviteCodeOf(c.env), pending.invite);
		const session = await startSession(c.env, profile, withInviteCode);
		// Someone already invited gets in whatever code they typed; only the turned away hear it was wrong.
		if (!session) {
			const wrongCode = !!pending.invite && !withInviteCode;
			return wrongCode ? back("wrong-invite-code") : back("not-invited", normalizeEmail(profile.email));
		}
		c.header("Set-Cookie", cookieHeader(SIGNIN_COOKIE, "", 0));
		c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, session, SESSION_DAYS * 86_400), { append: true });
		return c.redirect(safeReturn(pending.return), 302);
	});

	app.post("/auth/signout", async (c) => {
		const session = cookie(c.req.raw, SESSION_COOKIE);
		if (session) await identityStore(c.env)?.endSession(session);
		c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
		return c.json({ signedOut: true });
	});
}

/** A signed-in person's own account: who they are, their agents and tokens, and the apps connected as them. */
function accountRoutes(app: Hono<AuthEnv>) {
	app.get("/me", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "sign in to GitHive first" }, 401);
		// People who signed in before orgs existed get their personal org here.
		if (principal.kind === "user" && c.env.DB) await new OrgStore(c.env.DB).personalOrg(principal.user);
		// Whether the hosted agents can start for them: they've set a model, or they're GitHive's operators.
		const hosted = await hasModel(c.env, principal.kind === "access" ? HOUSE : principal.user.id);
		return c.json({ ...describe(principal), hostedAgents: hosted });
	});

	// Each agent with how much it may do for other people, and how much it did today.
	app.get("/me/agents", async (c) => {
		const agents = await store(c.env).agents(signedInUser(c.get("principal")).id);
		const limits = new AgentLimitStore(c.env.DB);
		const today = await limits.countsToday(agents.map((agent) => agent.id));
		const described = agents.map(async (agent) => ({
			...agent,
			limits: await limits.limitsOf(agent.id),
			today: today[agent.id],
		}));
		return c.json(await Promise.all(described));
	});

	// The owner's limits on an agent's work for other people: build and review, each a number a day or null.
	app.patch("/me/agents/:id/limits", async (c) => {
		const user = signedInUser(c.get("principal"));
		const agent = await store(c.env).ownAgent(user.id, c.req.param("id"));
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
		const limits = new AgentLimitStore(c.env.DB);
		const next = limitsFrom(body, await limits.limitsOf(agent.id));
		await limits.setLimits(agent.id, next);
		return c.json({ agent: agent.id, limits: next });
	});

	app.post("/me/agents", async (c) => {
		const user = signedInUser(c.get("principal"));
		const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
		return c.json(await store(c.env).createAgent(user.id, String(name ?? "")), 201);
	});

	app.delete("/me/agents/:id", async (c) => {
		const user = signedInUser(c.get("principal"));
		const agentId = c.req.param("id");
		await store(c.env).revokeAgent(user.id, agentId);
		// Revoke the agent's MCP grants too. Each grant's metadata names the agent it acts as.
		const helpers = oauthHelpers(c.env);
		if (helpers)
			for (const grant of await listGrants(helpers, user.id))
				if (grant.metadata?.agentId === agentId) await helpers.revokeGrant(grant.id, user.id);
		return c.json({ revoked: agentId });
	});

	// A new token is shown once, in this response.
	app.post("/me/agents/:id/tokens", async (c) => {
		const user = signedInUser(c.get("principal"));
		const body = await c.req
			.json<{ expires_in_days?: number | null }>()
			.catch(() => ({}) as { expires_in_days?: number | null });
		const days = body.expires_in_days === undefined ? undefined : body.expires_in_days;
		return c.json(await store(c.env).createToken(user.id, c.req.param("id"), days), 201);
	});

	app.delete("/me/tokens/:id", async (c) => {
		const user = signedInUser(c.get("principal"));
		await store(c.env).revokeToken(user.id, c.req.param("id"));
		return c.json({ revoked: c.req.param("id") });
	});

	// MCP clients connected through OAuth, each acting as one of your agents.
	app.get("/me/connections", async (c) => {
		const user = signedInUser(c.get("principal"));
		const helpers = oauthHelpers(c.env);
		return c.json(helpers ? await connections(helpers, user.id) : []);
	});

	app.delete("/me/connections/:id", async (c) => {
		const user = signedInUser(c.get("principal"));
		const helpers = oauthHelpers(c.env);
		if (!helpers) return c.json({ error: "no such connection" }, 404);
		await helpers.revokeGrant(c.req.param("id"), user.id);
		return c.json({ revoked: c.req.param("id") });
	});
}

/** Only an admin, through Access, manages these. Returns who the admin is, as the records name them. */
function requireAdmin(principal: Principal | undefined) {
	if (principal?.kind !== "access") fail(403, "invitations are managed by an admin, through Cloudflare Access");
	return principal.identity.kind === "person" ? principal.identity.value : `service token ${principal.identity.value}`;
}

/** Sign-in invitations, the requests to join, and who may use the hosted agents. */
function adminRoutes(app: Hono<AuthEnv>) {
	// Sign-in invitations.
	app.get("/admin/invites", async (c) => {
		requireAdmin(c.get("principal"));
		return c.json(await store(c.env).invites());
	});
	app.post("/admin/invites", async (c) => {
		const by = requireAdmin(c.get("principal"));
		const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
		return c.json({ invited: await store(c.env).invite(String(email ?? ""), by) }, 201);
	});
	app.delete("/admin/invites/:email", async (c) => {
		const by = requireAdmin(c.get("principal"));
		await store(c.env).uninvite(c.req.param("email"), by);
		return c.json({ uninvited: c.req.param("email") });
	});

	// Org invitations whose email an admin hasn't approved yet. Approve with POST /admin/invites, or decline here.
	app.get("/admin/invite-requests", async (c) => {
		requireAdmin(c.get("principal"));
		return c.json(await store(c.env).inviteRequests());
	});
	app.delete("/admin/invite-requests/:email", async (c) => {
		requireAdmin(c.get("principal"));
		await store(c.env).declineRequest(c.req.param("email"));
		return c.json({ declined: c.req.param("email") });
	});
}

/** The part of the OAuth provider's helpers these routes use. */
export interface OAuthHelpersLike {
	listUserGrants(
		userId: string,
		options?: { cursor?: string; limit?: number },
	): Promise<{
		items: {
			id: string;
			clientId: string;
			userId: string;
			scope: string[];
			metadata: { agentId?: string; agent?: string } | null;
			createdAt: number;
		}[];
		cursor?: string;
	}>;
	revokeGrant(grantId: string, userId: string): Promise<void>;
	lookupClient(clientId: string): Promise<{ clientName?: string } | null>;
}

const oauthHelpers = (env: Env) => (env as unknown as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER;

/** The MCP clients connected as one of this person's agents, each named as it registered. */
async function connections(helpers: OAuthHelpersLike, userId: string) {
	const grants = await listGrants(helpers, userId);
	const clients = new Map<string, string>();
	for (const grant of grants)
		if (!clients.has(grant.clientId))
			clients.set(grant.clientId, (await helpers.lookupClient(grant.clientId))?.clientName ?? grant.clientId);
	return grants.map((grant) => ({
		id: grant.id,
		client: clients.get(grant.clientId),
		agentId: grant.metadata?.agentId ?? null,
		agent: grant.metadata?.agent ?? null,
		createdAt: new Date(grant.createdAt * 1000).toISOString(),
	}));
}

async function listGrants(helpers: OAuthHelpersLike, userId: string) {
	const all = [];
	let cursor: string | undefined;
	do {
		const page = await helpers.listUserGrants(userId, cursor ? { cursor } : {});
		all.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	return all;
}
