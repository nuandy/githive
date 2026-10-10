import { verifyAccessRequest } from "../access";
import type { AccessIdentity } from "../access-contract";
import { identityLabel } from "../toolkit/stamp";
import { type Agent, IdentityStore, type User } from "./store";

// Who is calling. One of three doors:
// - Cloudflare Access (the admin and bench hostnames): a person or a service token;
// - GitHive's own sign-in: a person with a session cookie (the dashboard);
// - an agent, with a GitHive agent token (ghv_…) or an OAuth grant (MCP clients).

export type Principal =
	| { kind: "access"; identity: AccessIdentity }
	| { kind: "user"; user: User }
	| { kind: "agent"; user: User; agent: Agent };

export const SESSION_COOKIE = "__Host-githive_session";

/** The identity in GitHive's records. A person gets the same person:<hash> whichever door verified them. */
export function byOf(principal: Principal): string {
	return principal.kind === "access"
		? identityLabel(principal.identity)
		: identityLabel({ kind: "person", value: principal.user.email });
}

/** A signed-in agent's verified name, <handle>/<agent>; none for people and Access callers. */
export const agentNameOf = (principal: Principal) =>
	principal.kind === "agent" ? `${principal.user.handle}/${principal.agent.name}` : undefined;

/** A person, rather than an agent or a service token. Only people may vote from the dashboard. */
export const isPerson = (principal: Principal) =>
	principal.kind === "user" || (principal.kind === "access" && principal.identity.kind === "person");

export function cookie(request: Request, name: string) {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return undefined;
}

const bearer = (request: Request) => request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];

export const identityStore = (env: Env) => (env.DB ? new IdentityStore(env.DB) : null);

/** The caller, or null: an Access assertion first, then an agent token, then a session cookie. */
export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
	// Access is the admin door and only counts on the Access hostnames. The public address (githive.app) never
	// accepts an Access assertion, so nothing there can act as an admin.
	const publicOrigin = (env as unknown as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN;
	if (!publicOrigin || new URL(request.url).origin !== publicOrigin) {
		// Without its header this returns at once.
		const identity = await verifyAccessRequest(request, {
			teamDomain: env.ACCESS_TEAM_DOMAIN,
			audience: env.ACCESS_AUD,
		});
		if (identity) return { kind: "access", identity };
	}
	const store = identityStore(env);
	if (!store) return null;
	const token = bearer(request);
	if (token?.startsWith("ghv_")) {
		const found = await store.tokenPrincipal(token);
		return found ? { kind: "agent", ...found } : null;
	}
	const session = cookie(request, SESSION_COOKIE);
	if (session) {
		const user = await store.sessionUser(session);
		if (user) return { kind: "user", user };
	}
	return null;
}

/** What the dashboard shows about the caller. A person sees their own email; nothing else does. */
export function describe(principal: Principal) {
	if (principal.kind === "access") {
		const { identity } = principal;
		const label = identity.kind === "person" ? identity.value : `service token ${identity.value}`;
		return { kind: "access" as const, label, by: byOf(principal) };
	}
	const { handle, name, email, avatarUrl } = principal.user;
	if (principal.kind === "user") return { kind: "user" as const, handle, name, email, avatarUrl, by: byOf(principal) };
	return { kind: "agent" as const, handle, agent: agentNameOf(principal), by: byOf(principal) };
}
