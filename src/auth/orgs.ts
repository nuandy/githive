import { normalizeEmail } from "./store";

// Orgs, their people and their repos, and what a person may do in a repo.
//
// Every person has a personal org named for their handle. Other orgs have
// members (owner, admin, member) and teams. A repo belongs to one org, is
// private or public, and may have collaborators. A repo's id is its Artifacts
// name and the key its records are kept under; people and agents name it
// <org>/<name>, and only routes and tools translate.

export type Level = "read" | "review" | "write" | "admin";
export type Role = "owner" | "admin" | "member";
export type Visibility = "private" | "public";

const RANK: Record<Level, number> = { read: 1, review: 2, write: 3, admin: 4 };
export const LEVELS = Object.keys(RANK) as Level[];
export const atLeast = (level: Level | null, needed: Level) => !!level && RANK[level] >= RANK[needed];
const highest = (levels: (Level | null | undefined)[]) =>
	levels.reduce<Level | null>((best, l) => (l && (!best || RANK[l] > RANK[best]) ? l : best), null);

export const isLevel = (v: unknown): v is Level => typeof v === "string" && v in RANK;
export const isRole = (v: unknown): v is Role => v === "owner" || v === "admin" || v === "member";

/** An org's slug: lowercase letters, digits and single dashes. Never "--", which joins an org and a repo in a repo's id. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,37}[a-z0-9]$|^[a-z0-9]$/;
/** Names GitHive uses for itself, or that would read as its routes. */
const RESERVED = new Set(["fork", "records", "admin", "api", "auth", "me", "orgs", "repos", "settings", "githive", "new", "login", "logout", "mcp", "oauth", "authorize", "live", "summaries", "assets", "inbox"]);
const REPO_NAME = /^[A-Za-z0-9._](?:[A-Za-z0-9._]|-(?!-)){0,99}$/;

export const validSlug = (slug: string) => SLUG.test(slug) && !RESERVED.has(slug);
export const validRepoName = (name: string) => REPO_NAME.test(name) && name !== "." && name !== "..";

/** A new repo's id: its Artifacts name, unique because slugs never contain "--". */
export const repoIdFor = (org: string, name: string) => `${org}--${name.toLowerCase()}`;

export interface Org {
	id: string;
	slug: string;
	name: string | null;
	personal: boolean;
	defaultPermission: Level;
	membersCanCreateRepos: boolean;
}

export interface Repo {
	id: string;
	org: string;
	name: string;
	/** What people call it: <org>/<name>. */
	fullName: string;
	visibility: Visibility;
	createdAt: string;
}

type Row = Record<string, unknown>;
const toOrg = (r: Row): Org => ({
	id: String(r.id),
	slug: String(r.slug),
	name: r.name === null || r.name === undefined ? null : String(r.name),
	personal: !!r.personal_of,
	defaultPermission: String(r.default_permission) as Level,
	membersCanCreateRepos: Number(r.members_can_create_repos) === 1,
});
const toRepo = (r: Row): Repo => ({ id: String(r.id), org: String(r.org_slug), name: String(r.name), fullName: `${r.org_slug}/${r.name}`, visibility: String(r.visibility) as Visibility, createdAt: String(r.created_at) });

const fail = (status: number, message: string): never => {
	throw new Error(`[${status}] ${message}`);
};

const REPO_SELECT = "SELECT r.*, o.slug AS org_slug FROM repos r JOIN orgs o ON o.id = r.org_id";

export class OrgStore {
	constructor(
		private readonly db: D1Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	private iso() {
		return this.now().toISOString();
	}

	// Orgs

	/** A person's own org, named for their handle: made the first time it's needed. */
	async personalOrg(user: { id: string; handle: string }) {
		const found = await this.db.prepare("SELECT * FROM orgs WHERE personal_of = ?").bind(user.id).first<Row>();
		if (found) return toOrg(found);
		const id = crypto.randomUUID();
		const at = this.iso();
		await this.db.batch([
			this.db.prepare("INSERT INTO orgs (id, slug, personal_of, created_at) VALUES (?, ?, ?, ?)").bind(id, user.handle, user.id, at),
			this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, at),
		]);
		return toOrg((await this.db.prepare("SELECT * FROM orgs WHERE id = ?").bind(id).first<Row>())!);
	}

	/** Whether a slug is free for an org or a person's handle: they share one namespace. */
	async slugFree(slug: string) {
		const taken = await this.db.prepare("SELECT 1 FROM orgs WHERE slug = ? UNION SELECT 1 FROM users WHERE handle = ?").bind(slug, slug).first();
		return !taken;
	}

	async createOrg(owner: { id: string }, slug: string, name?: string | null) {
		const s = slug.trim().toLowerCase();
		if (!validSlug(s)) fail(400, "an org's name is 1 to 39 lowercase letters, digits or single dashes, not starting or ending with a dash, and not one GitHive uses");
		if (!(await this.slugFree(s))) fail(409, `${s} is taken`);
		const id = crypto.randomUUID();
		const at = this.iso();
		await this.db.batch([
			this.db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)").bind(id, s, name?.trim() || null, at),
			this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, owner.id, at),
		]);
		return (await this.org(s))!;
	}

	async org(slug: string) {
		const row = await this.db.prepare("SELECT * FROM orgs WHERE slug = ?").bind(slug).first<Row>();
		return row ? toOrg(row) : null;
	}

	/** The org, or a 404 that doesn't say whether it exists to someone who can't see it. */
	async orgOrFail(slug: string) {
		return (await this.org(slug)) ?? fail(404, `no org ${slug}`);
	}

	async roleIn(orgId: string, userId: string): Promise<Role | null> {
		const row = await this.db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId).first<Row>();
		return row ? (String(row.role) as Role) : null;
	}

	/** The orgs a person belongs to, theirs first, each with their role. */
	async orgsOf(userId: string) {
		const { results } = await this.db.prepare("SELECT o.*, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.personal_of IS NULL, o.slug").bind(userId).all<Row>();
		return results.map((r) => ({ ...toOrg(r), role: String(r.role) as Role }));
	}

	async updateOrg(orgId: string, patch: { name?: string | null; defaultPermission?: Level; membersCanCreateRepos?: boolean }) {
		if (patch.defaultPermission !== undefined && !isLevel(patch.defaultPermission)) fail(400, "default permission is read, review, write or admin");
		await this.db
			.prepare("UPDATE orgs SET name = COALESCE(?, name), default_permission = COALESCE(?, default_permission), members_can_create_repos = COALESCE(?, members_can_create_repos) WHERE id = ?")
			.bind(patch.name === undefined ? null : patch.name?.trim() || null, patch.defaultPermission ?? null, patch.membersCanCreateRepos === undefined ? null : patch.membersCanCreateRepos ? 1 : 0, orgId)
			.run();
	}

	// Members

	async members(orgId: string) {
		const { results } = await this.db.prepare("SELECT u.id, u.handle, u.name, u.avatar_url, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.role = 'member', u.handle").bind(orgId).all<Row>();
		return results.map((r) => ({ userId: String(r.id), handle: String(r.handle), name: r.name === null ? null : String(r.name), avatarUrl: r.avatar_url === null ? null : String(r.avatar_url), role: String(r.role) as Role }));
	}

	async invites(orgId: string) {
		const { results } = await this.db.prepare("SELECT email, role, created_at FROM org_invites WHERE org_id = ? ORDER BY created_at").bind(orgId).all<Row>();
		return results.map((r) => ({ email: String(r.email), role: String(r.role) as Role, createdAt: String(r.created_at) }));
	}

	/**
	 * Add someone to an org by email: at once if they have signed in, else as an
	 * invitation they take up when they first sign in, once an admin has
	 * approved their email.
	 */
	async addMember(org: Org, email: string, role: Role, invitedBy: string) {
		if (org.personal) fail(400, "a personal org has no members: add collaborators to its repos instead");
		if (!isRole(role)) fail(400, "a member's role is owner, admin or member");
		const address = normalizeEmail(email);
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) fail(400, `not an email address: ${email}`);
		const user = await this.db.prepare("SELECT id, handle FROM users WHERE email = ?").bind(address).first<Row>();
		const at = this.iso();
		if (user) {
			await this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role").bind(org.id, user.id, role, at).run();
			return { added: String(user.handle), role };
		}
		await this.db.prepare("INSERT INTO org_invites (org_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, email) DO UPDATE SET role = excluded.role").bind(org.id, address, role, invitedBy, at).run();
		// Someone GitHive's admin hasn't approved can't sign in yet: the invitation waits for that.
		const approved = !!(await this.db.prepare("SELECT 1 FROM invites WHERE email = ?").bind(address).first());
		return { invited: address, role, ...(approved ? {} : { awaitingApproval: true }) };
	}

	async uninvite(orgId: string, email: string) {
		await this.db.prepare("DELETE FROM org_invites WHERE org_id = ? AND email = ?").bind(orgId, normalizeEmail(email)).run();
	}

	/** A person who has just signed in joins every org that invited their email. */
	async acceptInvites(user: { id: string; email: string }) {
		const { results } = await this.db.prepare("SELECT org_id, role FROM org_invites WHERE email = ?").bind(normalizeEmail(user.email)).all<Row>();
		if (!results.length) return;
		const at = this.iso();
		await this.db.batch([
			...results.map((r) => this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING").bind(r.org_id, user.id, r.role, at)),
			this.db.prepare("DELETE FROM org_invites WHERE email = ?").bind(normalizeEmail(user.email)),
		]);
	}

	async setRole(orgId: string, userId: string, role: Role) {
		if (!isRole(role)) fail(400, "a member's role is owner, admin or member");
		if (role !== "owner") await this.keepAnOwner(orgId, userId);
		const { meta } = await this.db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?").bind(role, orgId, userId).run();
		if (!meta.changes) fail(404, "not a member");
	}

	async removeMember(orgId: string, userId: string) {
		await this.keepAnOwner(orgId, userId);
		await this.db.batch([
			this.db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId),
			this.db.prepare("DELETE FROM team_members WHERE user_id = ? AND team_id IN (SELECT id FROM teams WHERE org_id = ?)").bind(userId, orgId),
		]);
	}

	/** Refuses to leave an org with no owner. */
	private async keepAnOwner(orgId: string, leaving: string) {
		const { results } = await this.db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner'").bind(orgId).all<Row>();
		if (results.length === 1 && String(results[0].user_id) === leaving) fail(409, "an org needs an owner: make someone else an owner first");
	}

	async userByHandle(handle: string) {
		const row = await this.db.prepare("SELECT id, handle FROM users WHERE handle = ?").bind(handle.trim().toLowerCase()).first<Row>();
		return row ? { id: String(row.id), handle: String(row.handle) } : null;
	}

	// Teams

	async teams(orgId: string) {
		const [teams, members] = await Promise.all([
			this.db.prepare("SELECT * FROM teams WHERE org_id = ? ORDER BY slug").bind(orgId).all<Row>(),
			this.db.prepare("SELECT tm.team_id, u.handle FROM team_members tm JOIN users u ON u.id = tm.user_id JOIN teams t ON t.id = tm.team_id WHERE t.org_id = ? ORDER BY u.handle").bind(orgId).all<Row>(),
		]);
		return teams.results.map((t) => ({ id: String(t.id), slug: String(t.slug), name: t.name === null ? null : String(t.name), members: members.results.filter((m) => m.team_id === t.id).map((m) => String(m.handle)) }));
	}

	async createTeam(org: Org, slug: string, name?: string | null) {
		if (org.personal) fail(400, "a personal org has no teams");
		const s = slug.trim().toLowerCase();
		if (!SLUG.test(s)) fail(400, "a team's name is lowercase letters, digits or single dashes");
		const exists = await this.db.prepare("SELECT 1 FROM teams WHERE org_id = ? AND slug = ?").bind(org.id, s).first();
		if (exists) fail(409, `@${org.slug}/${s} exists`);
		await this.db.prepare("INSERT INTO teams (id, org_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), org.id, s, name?.trim() || null, this.iso()).run();
		return { team: `@${org.slug}/${s}` };
	}

	private async teamId(orgId: string, slug: string) {
		const row = await this.db.prepare("SELECT id FROM teams WHERE org_id = ? AND slug = ?").bind(orgId, slug).first<Row>();
		return row ? String(row.id) : fail(404, `no team ${slug}`);
	}

	async deleteTeam(orgId: string, slug: string) {
		const id = await this.teamId(orgId, slug);
		await this.db.batch([this.db.prepare("DELETE FROM team_members WHERE team_id = ?").bind(id), this.db.prepare("DELETE FROM teams WHERE id = ?").bind(id)]);
	}

	/** Add an org member to a team; only members can be on an org's teams. */
	async addTeamMember(orgId: string, slug: string, handle: string) {
		const id = await this.teamId(orgId, slug);
		const user = (await this.userByHandle(handle)) ?? fail(404, `no one is called ${handle}`);
		if (!(await this.roleIn(orgId, user.id))) fail(409, `${user.handle} isn't a member of this org`);
		await this.db.prepare("INSERT INTO team_members (team_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(id, user.id, this.iso()).run();
	}

	async removeTeamMember(orgId: string, slug: string, handle: string) {
		const id = await this.teamId(orgId, slug);
		const user = (await this.userByHandle(handle)) ?? fail(404, `no one is called ${handle}`);
		await this.db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(id, user.id).run();
	}

	/** The teams a person is on in an org, as grants name them: @<org>/<team>. */
	async teamsOf(userId: string, orgId: string) {
		const { results } = await this.db.prepare("SELECT o.slug AS org_slug, t.slug FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN orgs o ON o.id = t.org_id WHERE tm.user_id = ? AND t.org_id = ? ORDER BY t.slug").bind(userId, orgId).all<Row>();
		return results.map((r) => `@${r.org_slug}/${r.slug}`);
	}

	/** The teams a person is on in the org a repo belongs to: what their vote on it carries. */
	async teamsForRepo(userId: string, repoId: string) {
		const { results } = await this.db
			.prepare("SELECT o.slug AS org_slug, t.slug FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN orgs o ON o.id = t.org_id JOIN repos r ON r.org_id = t.org_id WHERE tm.user_id = ? AND r.id = ? ORDER BY t.slug")
			.bind(userId, repoId)
			.all<Row>();
		return results.map((r) => `@${r.org_slug}/${r.slug}`);
	}

	// Repos

	async repo(org: string, name: string) {
		const row = await this.db.prepare(`${REPO_SELECT} WHERE o.slug = ? AND r.name = ?`).bind(org, name).first<Row>();
		return row ? toRepo(row) : null;
	}

	async repoById(id: string) {
		const row = await this.db.prepare(`${REPO_SELECT} WHERE r.id = ?`).bind(id).first<Row>();
		return row ? toRepo(row) : null;
	}

	/** Record a repo in an org: a new one (id <org>--<name>) or one that already exists in Artifacts under `id`. */
	async addRepo(org: Org, name: string, createdBy: string | null, options: { visibility?: Visibility; id?: string } = {}) {
		if (!validRepoName(name)) fail(400, "a repo's name is letters, digits, dots, underscores or single dashes, up to 100");
		if (await this.repo(org.slug, name)) fail(409, `${org.slug}/${name} exists`);
		const id = options.id ?? repoIdFor(org.slug, name);
		if (await this.repoById(id)) fail(409, `that repo already belongs to an org`);
		await this.db.prepare("INSERT INTO repos (id, org_id, name, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, org.id, name, options.visibility ?? "private", createdBy, this.iso()).run();
		return (await this.repoById(id))!;
	}

	async setVisibility(repoId: string, visibility: Visibility) {
		if (visibility !== "private" && visibility !== "public") fail(400, "a repo is private or public");
		await this.db.prepare("UPDATE repos SET visibility = ? WHERE id = ?").bind(visibility, repoId).run();
	}

	async removeRepo(repoId: string) {
		await this.db.batch([this.db.prepare("DELETE FROM repo_collaborators WHERE repo_id = ?").bind(repoId), this.db.prepare("DELETE FROM repos WHERE id = ?").bind(repoId)]);
	}

	/** Every repo a person can see: their orgs', the ones they collaborate on, and public ones. */
	async visibleRepos(userId: string) {
		const { results } = await this.db
			.prepare(
				`${REPO_SELECT} WHERE r.visibility = 'public' OR r.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?) OR r.id IN (SELECT repo_id FROM repo_collaborators WHERE user_id = ?) ORDER BY o.slug, r.name`,
			)
			.bind(userId, userId)
			.all<Row>();
		return results.map(toRepo);
	}

	/** Every repo an org has, for its owners and Access admins. */
	async orgRepos(orgId: string) {
		const { results } = await this.db.prepare(`${REPO_SELECT} WHERE r.org_id = ? ORDER BY r.name`).bind(orgId).all<Row>();
		return results.map(toRepo);
	}

	/** Every repo recorded in an org, for Access admins. */
	async allRepos() {
		const { results } = await this.db.prepare(`${REPO_SELECT} ORDER BY o.slug, r.name`).all<Row>();
		return results.map(toRepo);
	}

	// Collaborators

	async collaborators(repoId: string) {
		const { results } = await this.db.prepare("SELECT u.handle, c.permission FROM repo_collaborators c JOIN users u ON u.id = c.user_id WHERE c.repo_id = ? ORDER BY u.handle").bind(repoId).all<Row>();
		return results.map((r) => ({ handle: String(r.handle), permission: String(r.permission) as Level }));
	}

	async setCollaborator(repoId: string, handle: string, permission: Level) {
		if (!isLevel(permission)) fail(400, "a permission is read, review, write or admin");
		const user = (await this.userByHandle(handle)) ?? fail(404, `no one is called ${handle}`);
		await this.db.prepare("INSERT INTO repo_collaborators (repo_id, user_id, permission, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, user_id) DO UPDATE SET permission = excluded.permission").bind(repoId, user.id, permission, this.iso()).run();
	}

	async removeCollaborator(repoId: string, handle: string) {
		const user = (await this.userByHandle(handle)) ?? fail(404, `no one is called ${handle}`);
		await this.db.prepare("DELETE FROM repo_collaborators WHERE repo_id = ? AND user_id = ?").bind(repoId, user.id).run();
	}

	// Permission

	/**
	 * What a person may do in a repo: the most of
	 * - read, if it's public;
	 * - admin for the org's owners and admins, the org's default for members;
	 * - what they were given as a collaborator.
	 * Null when they can't see it at all.
	 */
	async permission(userId: string, repoId: string): Promise<Level | null> {
		const row = await this.db
			.prepare(
				"SELECT r.visibility, o.default_permission, (SELECT role FROM org_members WHERE org_id = r.org_id AND user_id = ?) AS role, (SELECT permission FROM repo_collaborators WHERE repo_id = r.id AND user_id = ?) AS collaborator FROM repos r JOIN orgs o ON o.id = r.org_id WHERE r.id = ?",
			)
			.bind(userId, userId, repoId)
			.first<Row>();
		if (!row) return null;
		const role = row.role ? (String(row.role) as Role) : null;
		return highest([row.visibility === "public" ? "read" : null, role === "owner" || role === "admin" ? "admin" : role === "member" ? (String(row.default_permission) as Level) : null, row.collaborator ? (String(row.collaborator) as Level) : null]);
	}

	/** Whether a person may make repos in an org: its owners and admins, and members if the org allows. */
	async mayCreateRepo(org: Org, userId: string) {
		const role = await this.roleIn(org.id, userId);
		return role === "owner" || role === "admin" || (role === "member" && org.membersCanCreateRepos);
	}
}
