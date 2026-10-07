// GitHive's identity store in D1: people and the accounts they sign in with,
// their sessions, the agents they own and those agents' tokens, and the
// invitations sign-in needs until repos have permissions. Secrets (session
// ids, agent tokens) are stored only as SHA-256 hashes.

export interface User {
	id: string;
	/** Unique and public: a GitHub login, or u-<hex> for a Google account. Names the person's agents: <handle>/<agent>. */
	handle: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	createdAt: string;
}

export interface Agent {
	id: string;
	ownerId: string;
	name: string;
	createdAt: string;
	revokedAt: string | null;
}

export interface AgentToken {
	id: string;
	agentId: string;
	/** The first characters after ghv_, to tell tokens apart. */
	prefix: string;
	createdAt: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/** Who a provider says signed in, with an email the provider has verified. */
export interface ProviderProfile {
	provider: "github" | "google";
	providerId: string;
	email: string;
	name?: string | null;
	avatarUrl?: string | null;
	/** The provider's username, used as the handle when it's free (GitHub's login). */
	login?: string | null;
}

export const SESSION_DAYS = 30;
export const TOKEN_DAYS = 90;
const MAX_TOKEN_DAYS = 365;
/** A token's last use is written at most this often. */
const TOUCH_MS = 5 * 60_000;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function sha256Hex(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random secret, base64url, from `bytes` random bytes. */
export function randomSecret(bytes = 32) {
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const fail = (status: number, message: string): never => {
	throw new Error(`[${status}] ${message}`);
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const toUser = (r: Row): User => ({ id: String(r.id), handle: String(r.handle), email: String(r.email), name: str(r.name), avatarUrl: str(r.avatar_url), createdAt: String(r.created_at) });
const toAgent = (r: Row): Agent => ({ id: String(r.id), ownerId: String(r.owner_id), name: String(r.name), createdAt: String(r.created_at), revokedAt: str(r.revoked_at) });
const toToken = (r: Row): AgentToken => ({
	id: String(r.id),
	agentId: String(r.agent_id),
	prefix: String(r.prefix),
	createdAt: String(r.created_at),
	expiresAt: str(r.expires_at),
	lastUsedAt: str(r.last_used_at),
	revokedAt: str(r.revoked_at),
});

export class IdentityStore {
	constructor(
		private readonly db: D1Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	private iso(offsetMs = 0) {
		return new Date(this.now().getTime() + offsetMs).toISOString();
	}

	// Invitations

	async invite(email: string, invitedBy: string) {
		const address = normalizeEmail(email);
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) fail(400, `not an email address: ${email}`);
		await this.db.prepare("INSERT INTO invites (email, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING").bind(address, invitedBy, this.iso()).run();
		return address;
	}

	async uninvite(email: string) {
		await this.db.prepare("DELETE FROM invites WHERE email = ?").bind(normalizeEmail(email)).run();
	}

	async invites() {
		const { results } = await this.db.prepare("SELECT email, invited_by, created_at FROM invites ORDER BY created_at").all<Row>();
		return results.map((r) => ({ email: String(r.email), invitedBy: String(r.invited_by), createdAt: String(r.created_at) }));
	}

	// Sign-in

	/**
	 * The user a provider's sign-in is for: the one already linked to this
	 * account, else the one with this verified email (the account is linked to
	 * it), else a new user, if their email is invited.
	 */
	async signIn(profile: ProviderProfile): Promise<{ user: User } | { refused: "not-invited" }> {
		const email = normalizeEmail(profile.email);
		const linked = await this.db.prepare("SELECT u.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.provider = ? AND a.provider_id = ?").bind(profile.provider, profile.providerId).first<Row>();
		if (linked) return { user: toUser(linked) };
		const byEmail = await this.db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<Row>();
		if (byEmail) {
			await this.link(String(byEmail.id), profile);
			return { user: toUser(byEmail) };
		}
		// Invited by an admin, or by an org that wants them as a member.
		if (!(await this.db.prepare("SELECT 1 FROM invites WHERE email = ? UNION SELECT 1 FROM org_invites WHERE email = ?").bind(email, email).first())) return { refused: "not-invited" };
		const user: User = { id: crypto.randomUUID(), handle: await this.freeHandle(profile), email, name: profile.name ?? null, avatarUrl: profile.avatarUrl ?? null, createdAt: this.iso() };
		await this.db.batch([
			this.db.prepare("INSERT INTO users (id, handle, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(user.id, user.handle, user.email, user.name, user.avatarUrl, user.createdAt),
			this.db.prepare("INSERT INTO accounts (provider, provider_id, user_id, created_at) VALUES (?, ?, ?, ?)").bind(profile.provider, profile.providerId, user.id, user.createdAt),
		]);
		return { user };
	}

	private async link(userId: string, profile: ProviderProfile) {
		await this.db.prepare("INSERT INTO accounts (provider, provider_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(profile.provider, profile.providerId, userId, this.iso()).run();
	}

	/** The provider's login when it makes a free handle (GitHub's), else u-<hex>: never derived from an email. */
	private async freeHandle(profile: ProviderProfile) {
		const login = profile.login?.trim().toLowerCase();
		// Handles and org names share one namespace: a person's handle names their personal org.
		const taken = async (handle: string) => !!(await this.db.prepare("SELECT 1 FROM users WHERE handle = ? UNION SELECT 1 FROM orgs WHERE slug = ?").bind(handle, handle).first());
		if (login && HANDLE.test(login) && !(await taken(login))) return login;
		for (;;) {
			const handle = `u-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
			if (!(await taken(handle))) return handle;
		}
	}

	async userById(id: string) {
		const row = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Row>();
		return row ? toUser(row) : null;
	}

	// Sessions

	/** A new session for the user: returns the secret for the cookie, which is stored only as a hash. */
	async createSession(userId: string) {
		const secret = randomSecret();
		await this.db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(secret), userId, this.iso(), this.iso(SESSION_DAYS * 86_400_000)).run();
		return secret;
	}

	async sessionUser(secret: string) {
		const row = await this.db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?").bind(await sha256Hex(secret), this.iso()).first<Row>();
		return row ? toUser(row) : null;
	}

	async endSession(secret: string) {
		await this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(secret)).run();
	}

	// Agents

	/** A new agent for the user, or a revoked one of theirs by that name made active again (its old tokens stay revoked). */
	async createAgent(ownerId: string, name: string): Promise<Agent> {
		const agentName = name.trim().toLowerCase();
		if (!AGENT_NAME.test(agentName)) fail(400, "an agent's name is 1 to 32 lowercase letters, digits or dashes, starting with a letter or digit");
		const existing = await this.db.prepare("SELECT * FROM agents WHERE owner_id = ? AND name = ?").bind(ownerId, agentName).first<Row>();
		if (existing && !existing.revoked_at) fail(409, `you already have an agent named ${agentName}`);
		if (existing) {
			await this.db.prepare("UPDATE agents SET revoked_at = NULL WHERE id = ?").bind(existing.id).run();
			return { ...toAgent(existing), revokedAt: null };
		}
		const agent: Agent = { id: crypto.randomUUID(), ownerId, name: agentName, createdAt: this.iso(), revokedAt: null };
		await this.db.prepare("INSERT INTO agents (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)").bind(agent.id, ownerId, agent.name, agent.createdAt).run();
		return agent;
	}

	/** The user's agents (revoked ones too), each with its tokens. */
	async agents(ownerId: string) {
		const [agents, tokens] = await Promise.all([
			this.db.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at").bind(ownerId).all<Row>(),
			this.db.prepare("SELECT t.* FROM agent_tokens t JOIN agents a ON a.id = t.agent_id WHERE a.owner_id = ? ORDER BY t.created_at").bind(ownerId).all<Row>(),
		]);
		return agents.results.map((r) => ({ ...toAgent(r), tokens: tokens.results.filter((t) => t.agent_id === r.id).map(toToken) }));
	}

	/** The user's own agent, or a 404. */
	async ownAgent(ownerId: string, agentId: string) {
		const row = await this.db.prepare("SELECT * FROM agents WHERE id = ? AND owner_id = ?").bind(agentId, ownerId).first<Row>();
		return row ? toAgent(row) : fail(404, "no such agent");
	}

	/** An active agent and its owner, or null: what an OAuth grant's props are checked against on every call. */
	async activeAgent(agentId: string) {
		const row = await this.db.prepare("SELECT a.id AS agent_id, a.owner_id, a.name AS agent_name, a.created_at AS agent_created_at, u.* FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id = ? AND a.revoked_at IS NULL").bind(agentId).first<Row>();
		if (!row) return null;
		return { user: toUser(row), agent: { id: String(row.agent_id), ownerId: String(row.owner_id), name: String(row.agent_name), createdAt: String(row.agent_created_at), revokedAt: null } as Agent };
	}

	/** Revoke an agent and every token it has. */
	async revokeAgent(ownerId: string, agentId: string) {
		await this.ownAgent(ownerId, agentId);
		const at = this.iso();
		await this.db.batch([
			this.db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(at, agentId),
			this.db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").bind(at, agentId),
		]);
	}

	// Agent tokens

	/** A new token for one of the user's active agents: the secret is returned once and stored only as a hash. */
	async createToken(ownerId: string, agentId: string, expiresInDays: number | null = TOKEN_DAYS) {
		const agent = await this.ownAgent(ownerId, agentId);
		if (agent.revokedAt) fail(409, `${agent.name} is revoked`);
		if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_TOKEN_DAYS)) fail(400, `a token lasts 1 to ${MAX_TOKEN_DAYS} days`);
		const secret = `ghv_${randomSecret()}`;
		const token: AgentToken = {
			id: crypto.randomUUID(),
			agentId,
			prefix: secret.slice(4, 12),
			createdAt: this.iso(),
			expiresAt: expiresInDays === null ? null : this.iso(expiresInDays * 86_400_000),
			lastUsedAt: null,
			revokedAt: null,
		};
		await this.db.prepare("INSERT INTO agent_tokens (id, agent_id, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(token.id, agentId, await sha256Hex(secret), token.prefix, token.createdAt, token.expiresAt).run();
		return { token: secret, ...token };
	}

	async revokeToken(ownerId: string, tokenId: string) {
		const row = await this.db.prepare("SELECT t.id FROM agent_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.id = ? AND a.owner_id = ?").bind(tokenId, ownerId).first<Row>();
		if (!row) fail(404, "no such token");
		await this.db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(this.iso(), tokenId).run();
	}

	/** The agent and owner a token is for, if it's live: not revoked, not expired, and its agent not revoked. */
	async tokenPrincipal(secret: string) {
		if (!secret.startsWith("ghv_")) return null;
		const row = await this.db
			.prepare(
				"SELECT t.id AS token_id, t.expires_at AS token_expires_at, t.last_used_at, a.id AS agent_id, a.owner_id, a.name AS agent_name, a.created_at AS agent_created_at, u.* FROM agent_tokens t JOIN agents a ON a.id = t.agent_id JOIN users u ON u.id = a.owner_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND a.revoked_at IS NULL",
			)
			.bind(await sha256Hex(secret))
			.first<Row>();
		if (!row) return null;
		const now = this.iso();
		if (row.token_expires_at && String(row.token_expires_at) <= now) return null;
		if (!row.last_used_at || Date.parse(String(row.last_used_at)) < this.now().getTime() - TOUCH_MS) await this.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.token_id).run();
		return { user: toUser(row), agent: { id: String(row.agent_id), ownerId: String(row.owner_id), name: String(row.agent_name), createdAt: String(row.agent_created_at), revokedAt: null } as Agent };
	}
}
