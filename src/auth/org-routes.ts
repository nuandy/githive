import type { Hono } from "hono";
import { type Level, type Org, OrgStore, type Role } from "./orgs";
import type { Principal } from "./principal";

// Org routes: create and view orgs, and manage members, invitations and teams. Owners and admins manage, only
// owners grant or remove the owner role, and anyone may leave. Access admins may do all of it.

type OrgEnv = { Bindings: Env; Variables: { principal?: Principal } };

const fail = (status: number, message: string): never => {
	throw new Error(`[${status}] ${message}`);
};

const jsonBody = async (c: { req: { json<T>(): Promise<T> } }) => {
	const parsed = await c.req.json<Record<string, unknown> | null>().catch(() => null);
	return parsed && typeof parsed === "object" ? parsed : {};
};

const store = (env: Env) => new OrgStore(env.DB ?? fail(503, "orgs aren't set up here (no identity database)"));

/** The caller's role in an org; an Access admin counts as an owner. */
async function roleIn(orgs: OrgStore, org: Org, principal: Principal | undefined): Promise<Role | null> {
	if (!principal) return fail(401, "sign in to GitHive first");
	if (principal.kind === "access") return "owner";
	return orgs.roleIn(org.id, principal.user.id);
}

async function managing(orgs: OrgStore, org: Org, principal: Principal | undefined) {
	const role = await roleIn(orgs, org, principal);
	if (role !== "owner" && role !== "admin") fail(403, `only ${org.slug}'s owners and admins can do that`);
	return role;
}

/** The org a route names and the caller's role in it, if the caller is one of its owners or admins. */
async function managedOrg(env: Env, slug: string, principal: Principal | undefined) {
	const orgs = store(env);
	const org = await orgs.orgOrFail(slug);
	const role = await managing(orgs, org, principal);
	return { orgs, org, role };
}

function actorLabel(principal: Principal | undefined) {
	if (principal?.kind === "access") return principal.identity.value;
	return principal ? principal.user.handle : "";
}

async function userOrFail(orgs: OrgStore, handle: string) {
	return (await orgs.userByHandle(handle)) ?? fail(404, `no one is called ${handle}`);
}

/** The org's repos the caller can see. An Access admin sees all of them. */
async function reposIn(orgs: OrgStore, org: Org, principal: Principal | undefined) {
	if (principal?.kind === "access") return orgs.orgRepos(org.id);
	const userId = (principal as Exclude<Principal, { kind: "access" }>).user.id;
	const visible = await orgs.visibleRepos(userId);
	return visible.filter((repo) => repo.org === org.slug);
}

/** An org's members and teams, shown to its members, and its invitations, shown to its owners and admins. */
async function peopleIn(orgs: OrgStore, org: Org, role: Role | null) {
	if (role === null) return { members: [], teams: [], invites: [] };
	const manager = role === "owner" || role === "admin";
	const [members, teams, invites] = await Promise.all([
		orgs.members(org.id),
		orgs.teams(org.id),
		manager ? orgs.invites(org.id) : Promise.resolve([]),
	]);
	return { members, teams, invites };
}

export function orgRoutes(app: Hono<OrgEnv>) {
	// The caller's orgs with their role in each, personal org first.
	app.get("/orgs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind === "access" || !principal) return c.json([]);
		const orgs = store(c.env);
		// People who signed in before orgs existed get their personal org here.
		await orgs.personalOrg(principal.user);
		return c.json(await orgs.orgsOf(principal.user.id));
	});

	app.post("/orgs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") return fail(403, "a person signed in to GitHive makes an org");
		const { slug, name } = await jsonBody(c);
		const org = await store(c.env).createOrg(
			principal.user,
			String(slug ?? ""),
			typeof name === "string" ? name : null,
		);
		return c.json(org, 201);
	});

	// An org and the repos the caller can see. Members also see its people and teams.
	app.get("/orgs/:org", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		const principal = c.get("principal");
		const role = await roleIn(orgs, org, principal);
		const repos = await reposIn(orgs, org, principal);
		const { members, teams, invites } = await peopleIn(orgs, org, role);
		const canCreateRepos =
			principal?.kind === "access" || (principal ? await orgs.mayCreateRepo(org, principal.user.id) : false);
		return c.json({ ...org, role, canCreateRepos, repos, members, teams, invites });
	});

	app.patch("/orgs/:org", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		const {
			name,
			default_permission: defaultPermission,
			members_can_create_repos: membersCanCreateRepos,
		} = await jsonBody(c);
		const patch: Parameters<OrgStore["updateOrg"]>[1] = {};
		if (name !== undefined) patch.name = name === null ? null : String(name);
		if (defaultPermission !== undefined) patch.defaultPermission = defaultPermission as Level;
		if (membersCanCreateRepos !== undefined) patch.membersCanCreateRepos = !!membersCanCreateRepos;
		await orgs.updateOrg(org.id, patch);
		return c.json(await orgs.org(org.slug));
	});

	memberRoutes(app);
	teamRoutes(app);
}

function memberRoutes(app: Hono<OrgEnv>) {
	// Members are added by email. Someone who hasn't signed in yet gets an invitation.
	app.post("/orgs/:org/members", async (c) => {
		const { orgs, org, role } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		const { email, role: newRole = "member" } = await jsonBody(c);
		if (newRole === "owner" && role !== "owner") fail(403, "only an owner can add an owner");
		const added = await orgs.addMember(org, String(email ?? ""), newRole as Role, actorLabel(c.get("principal")));
		return c.json(added, 201);
	});

	app.patch("/orgs/:org/members/:handle", async (c) => {
		const { orgs, org, role } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		const user = await userOrFail(orgs, c.req.param("handle"));
		const { role: newRole } = await jsonBody(c);
		const current = await orgs.roleIn(org.id, user.id);
		if ((newRole === "owner" || current === "owner") && role !== "owner")
			fail(403, "only an owner can make or unmake an owner");
		await orgs.setRole(org.id, user.id, newRole as Role);
		return c.json({ member: user.handle, role: newRole });
	});

	app.delete("/orgs/:org/members/:handle", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		const principal = c.get("principal");
		const user = await userOrFail(orgs, c.req.param("handle"));
		const leaving = principal?.kind !== "access" && principal?.user.id === user.id;
		if (!leaving) {
			const role = await managing(orgs, org, principal);
			if ((await orgs.roleIn(org.id, user.id)) === "owner" && role !== "owner")
				fail(403, "only an owner can remove an owner");
		}
		await orgs.removeMember(org.id, user.id);
		return c.json({ removed: user.handle });
	});

	app.delete("/orgs/:org/invites/:email", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		await orgs.uninvite(org.id, c.req.param("email"));
		return c.json({ uninvited: c.req.param("email") });
	});
}

// Teams are named groups of members. Grants refer to them as @<org>/<team>.
function teamRoutes(app: Hono<OrgEnv>) {
	app.post("/orgs/:org/teams", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		const { slug, name } = await jsonBody(c);
		return c.json(await orgs.createTeam(org, String(slug ?? ""), typeof name === "string" ? name : null), 201);
	});

	app.delete("/orgs/:org/teams/:team", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		await orgs.deleteTeam(org.id, c.req.param("team"));
		return c.json({ deleted: `@${org.slug}/${c.req.param("team")}` });
	});

	app.put("/orgs/:org/teams/:team/members/:handle", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		await orgs.addTeamMember(org.id, c.req.param("team"), c.req.param("handle"));
		return c.json({ team: `@${org.slug}/${c.req.param("team")}`, added: c.req.param("handle") });
	});

	app.delete("/orgs/:org/teams/:team/members/:handle", async (c) => {
		const { orgs, org } = await managedOrg(c.env, c.req.param("org"), c.get("principal"));
		await orgs.removeTeamMember(org.id, c.req.param("team"), c.req.param("handle"));
		return c.json({ team: `@${org.slug}/${c.req.param("team")}`, removed: c.req.param("handle") });
	});
}
