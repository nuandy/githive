import type { Hono } from "hono";
import { type Level, type Org, OrgStore, type Role } from "./orgs";
import type { Principal } from "./principal";

// Orgs and their people: make an org, see one, and manage its members,
// invitations and teams. Owners and admins manage; only owners make or
// unmake owners; anyone may leave. Access admins may do all of it.

type OrgEnv = { Bindings: Env; Variables: { principal?: Principal } };

const fail = (status: number, message: string): never => {
	throw new Error(`[${status}] ${message}`);
};

const body = async (c: { req: { json<T>(): Promise<T> } }) => {
	const parsed = await c.req.json<Record<string, unknown> | null>().catch(() => null);
	return parsed && typeof parsed === "object" ? parsed : {};
};

export function orgRoutes(app: Hono<OrgEnv>) {
	const store = (env: Env) => new OrgStore(env.DB ?? fail(503, "orgs aren't set up here (no identity database)"));

	/** The caller's role in an org; an Access admin counts as an owner. */
	const roleIn = async (orgs: OrgStore, org: Org, principal: Principal | undefined): Promise<Role | null> => {
		if (!principal) return fail(401, "sign in to GitHive first");
		if (principal.kind === "access") return "owner";
		return orgs.roleIn(org.id, principal.user.id);
	};
	const managing = async (orgs: OrgStore, org: Org, principal: Principal | undefined) => {
		const role = await roleIn(orgs, org, principal);
		if (role !== "owner" && role !== "admin") fail(403, `only ${org.slug}'s owners and admins can do that`);
		return role;
	};
	const actorLabel = (principal: Principal | undefined) =>
		principal?.kind === "access" ? principal.identity.value : principal ? principal.user.handle : "";

	// The caller's orgs, with their role in each; their own namespace first.
	app.get("/orgs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind === "access" || !principal) return c.json([]);
		const orgs = store(c.env);
		// Someone who signed in before orgs existed gets their own namespace now.
		await orgs.personalOrg(principal.user);
		return c.json(await orgs.orgsOf(principal.user.id));
	});

	app.post("/orgs", async (c) => {
		const principal = c.get("principal");
		if (principal?.kind !== "user") fail(403, "a person signed in to GitHive makes an org");
		const { slug, name } = await body(c);
		return c.json(
			await store(c.env).createOrg(
				(principal as Extract<Principal, { kind: "user" }>).user,
				String(slug ?? ""),
				typeof name === "string" ? name : null,
			),
			201,
		);
	});

	// An org: its repos the caller can see; to its members, its people and teams too.
	app.get("/orgs/:org", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		const principal = c.get("principal");
		const role = await roleIn(orgs, org, principal);
		const repos =
			principal?.kind === "access"
				? await orgs.orgRepos(org.id)
				: (await orgs.visibleRepos((principal as Exclude<Principal, { kind: "access" }>).user.id)).filter(
						(r) => r.org === org.slug,
					);
		const member = role !== null;
		const [members, teams, invites] = member
			? await Promise.all([
					orgs.members(org.id),
					orgs.teams(org.id),
					role === "owner" || role === "admin" ? orgs.invites(org.id) : Promise.resolve([]),
				])
			: [[], [], []];
		const canCreate =
			principal?.kind === "access" || (principal ? await orgs.mayCreateRepo(org, principal.user.id) : false);
		return c.json({ ...org, role, canCreateRepos: canCreate, repos, members, teams, invites });
	});

	app.patch("/orgs/:org", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		const {
			name,
			default_permission: defaultPermission,
			members_can_create_repos: membersCanCreateRepos,
		} = await body(c);
		await orgs.updateOrg(org.id, {
			...(name !== undefined ? { name: name === null ? null : String(name) } : {}),
			...(defaultPermission !== undefined ? { defaultPermission: defaultPermission as Level } : {}),
			...(membersCanCreateRepos !== undefined ? { membersCanCreateRepos: !!membersCanCreateRepos } : {}),
		});
		return c.json(await orgs.org(org.slug));
	});

	// Members: add by email (at once if they've signed in, else as an invitation), change a role, remove.
	app.post("/orgs/:org/members", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		const role = await managing(orgs, org, c.get("principal"));
		const { email, role: newRole = "member" } = await body(c);
		if (newRole === "owner" && role !== "owner") fail(403, "only an owner can add an owner");
		return c.json(await orgs.addMember(org, String(email ?? ""), newRole as Role, actorLabel(c.get("principal"))), 201);
	});

	app.patch("/orgs/:org/members/:handle", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		const role = await managing(orgs, org, c.get("principal"));
		const user =
			(await orgs.userByHandle(c.req.param("handle"))) ?? fail(404, `no one is called ${c.req.param("handle")}`);
		const { role: newRole } = await body(c);
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
		const user =
			(await orgs.userByHandle(c.req.param("handle"))) ?? fail(404, `no one is called ${c.req.param("handle")}`);
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
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		await orgs.uninvite(org.id, c.req.param("email"));
		return c.json({ uninvited: c.req.param("email") });
	});

	// Teams: named groups of members, which grants name as @<org>/<team>.
	app.post("/orgs/:org/teams", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		const { slug, name } = await body(c);
		return c.json(await orgs.createTeam(org, String(slug ?? ""), typeof name === "string" ? name : null), 201);
	});

	app.delete("/orgs/:org/teams/:team", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		await orgs.deleteTeam(org.id, c.req.param("team"));
		return c.json({ deleted: `@${org.slug}/${c.req.param("team")}` });
	});

	app.put("/orgs/:org/teams/:team/members/:handle", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		await orgs.addTeamMember(org.id, c.req.param("team"), c.req.param("handle"));
		return c.json({ team: `@${org.slug}/${c.req.param("team")}`, added: c.req.param("handle") });
	});

	app.delete("/orgs/:org/teams/:team/members/:handle", async (c) => {
		const orgs = store(c.env);
		const org = await orgs.orgOrFail(c.req.param("org"));
		await managing(orgs, org, c.get("principal"));
		await orgs.removeTeamMember(org.id, c.req.param("team"), c.req.param("handle"));
		return c.json({ team: `@${org.slug}/${c.req.param("team")}`, removed: c.req.param("handle") });
	});
}
