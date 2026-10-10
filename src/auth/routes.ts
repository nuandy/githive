import { Hono } from "hono";
import { type Principal, SESSION_COOKIE, cookie, describe, identityStore } from "./principal";
import { PROVIDERS, type ProviderConfig, type ProviderName, isProvider, pkceChallenge } from "./providers";
import { OrgStore } from "./orgs";
import { type IdentityStore, SESSION_DAYS, randomSecret } from "./store";
import { fail } from "../errors";

// Sign-in with GitHub or Google, and a signed-in person's own agents, tokens and connected MCP clients.
// Admins behind Access manage invitations here too.

export type AuthEnv = { Bindings: Env; Variables: { principal?: Principal } };

const SIGNIN_COOKIE = "__Host-githive_signin";

const cookieHeader = (name: string, value: string, maxAgeSeconds: number) =>
	`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

/** Accepts only a path on this site, never another origin ("//evil", "https://…"). */
export const safeReturn = (value: string | undefined | null) =>
	value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";

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

export function authRoutes(app: Hono<AuthEnv>) {
	app.get("/auth/providers", (c) =>
		c.json({ providers: (["github", "google"] as const).filter((p) => providerConfig(c.env, p)) }),
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
		const pending = JSON.stringify({ provider: name, state, verifier, return: safeReturn(c.req.query("return")) });
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
		const back = (error: string) => {
			c.header("Set-Cookie", cookieHeader(SIGNIN_COOKIE, "", 0));
			return c.redirect(`/?signin_error=${encodeURIComponent(error)}`, 302);
		};
		if (!isProvider(name)) return c.json({ error: `no sign-in with ${name}` }, 404);
		const config = providerConfig(c.env, name);
		if (!config) return c.json({ error: `sign-in with ${name} isn't set up here` }, 404);
		let pending: { provider: string; state: string; verifier: string; return: string } | null = null;
		try {
			pending = JSON.parse(cookie(c.req.raw, SIGNIN_COOKIE) ?? "null");
		} catch {
			pending = null;
		}
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
		const ids = store(c.env);
		const signed = await ids.signIn(profile);
		if ("refused" in signed) return back("not-invited");
		const orgs = new OrgStore(c.env.DB);
		await orgs.personalOrg(signed.user);
		await orgs.acceptInvites(signed.user);
		const session = await ids.createSession(signed.user.id);
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

	app.get("/me", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "sign in to GitHive first" }, 401);
		// People who signed in before orgs existed get their personal org here.
		if (principal.kind === "user" && c.env.DB) await new OrgStore(c.env.DB).personalOrg(principal.user);
		let hosted = false;
		if (principal.kind === "access") hosted = true;
		else if (c.env.DB) hosted = await store(c.env).mayUseHosted(principal.user.id);
		return c.json({ ...describe(principal), hostedAgents: hosted });
	});

	app.get("/me/agents", async (c) => c.json(await store(c.env).agents(signedInUser(c.get("principal")).id)));

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
		const helpers = (c.env as unknown as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER;
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
		const helpers = (c.env as unknown as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER;
		if (!helpers) return c.json([]);
		const grants = await listGrants(helpers, user.id);
		const clients = new Map<string, string>();
		for (const g of grants)
			if (!clients.has(g.clientId))
				clients.set(g.clientId, (await helpers.lookupClient(g.clientId))?.clientName ?? g.clientId);
		return c.json(
			grants.map((g) => ({
				id: g.id,
				client: clients.get(g.clientId),
				agentId: g.metadata?.agentId ?? null,
				agent: g.metadata?.agent ?? null,
				createdAt: new Date(g.createdAt * 1000).toISOString(),
			})),
		);
	});

	app.delete("/me/connections/:id", async (c) => {
		const user = signedInUser(c.get("principal"));
		const helpers = (c.env as unknown as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER;
		if (!helpers) return c.json({ error: "no such connection" }, 404);
		await helpers.revokeGrant(c.req.param("id"), user.id);
		return c.json({ revoked: c.req.param("id") });
	});

	// Sign-in invitations. Only an admin, through Access, manages them.
	const admin = (principal: Principal | undefined) => {
		if (principal?.kind !== "access") fail(403, "invitations are managed by an admin, through Cloudflare Access");
		return principal.identity.kind === "person"
			? principal.identity.value
			: `service token ${principal.identity.value}`;
	};
	app.get("/admin/invites", async (c) => {
		admin(c.get("principal"));
		return c.json(await store(c.env).invites());
	});
	app.post("/admin/invites", async (c) => {
		const by = admin(c.get("principal"));
		const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
		return c.json({ invited: await store(c.env).invite(String(email ?? ""), by) }, 201);
	});
	app.delete("/admin/invites/:email", async (c) => {
		admin(c.get("principal"));
		await store(c.env).uninvite(c.req.param("email"));
		return c.json({ uninvited: c.req.param("email") });
	});

	// Org invitations whose email an admin hasn't approved yet. Approve with POST /admin/invites, or decline here.
	app.get("/admin/invite-requests", async (c) => {
		admin(c.get("principal"));
		return c.json(await store(c.env).inviteRequests());
	});
	app.delete("/admin/invite-requests/:email", async (c) => {
		admin(c.get("principal"));
		await store(c.env).declineRequest(c.req.param("email"));
		return c.json({ declined: c.req.param("email") });
	});

	// Who may use the hosted agents (build, request_review). They spend GitHive's model account.
	app.get("/admin/hosted-agents", async (c) => {
		admin(c.get("principal"));
		return c.json(await store(c.env).hostedUsers());
	});
	app.put("/admin/hosted-agents/:handle", async (c) => {
		const by = admin(c.get("principal"));
		return c.json({ allowed: await store(c.env).allowHosted(c.req.param("handle"), by) });
	});
	app.delete("/admin/hosted-agents/:handle", async (c) => {
		admin(c.get("principal"));
		await store(c.env).disallowHosted(c.req.param("handle"));
		return c.json({ disallowed: c.req.param("handle") });
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
