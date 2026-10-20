import { beforeEach, describe, expect, it } from "vitest";
import { OrgStore, atLeast, repoIdFor, validSlug } from "../src/auth/orgs";
import { IdentityStore } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// Orgs and what people may do in their repos, against SQLite with the
// migrations applied.

let ids: IdentityStore;
let orgs: OrgStore;
type U = { id: string; handle: string; email: string };
const HANDLES = ["ada", "bob", "cyd", "eve"] as const;
type Handle = (typeof HANDLES)[number];
const people = {} as Record<Handle, U>;

async function person(handle: Handle) {
	await ids.invite(`${handle}@example.com`, "admin@example.com");
	const { user } = (await ids.signIn({
		provider: "github",
		providerId: handle,
		email: `${handle}@example.com`,
		login: handle,
	})) as { user: U };
	await orgs.personalOrg(user);
	await orgs.acceptInvites(user);
	return (people[handle] = user);
}

beforeEach(async () => {
	const db = fakeD1();
	ids = new IdentityStore(db);
	orgs = new OrgStore(db);
	for (const h of HANDLES) await person(h);
});

describe("orgs", () => {
	it("gives everyone a personal org named for their handle, owned by them", async () => {
		const mine = await orgs.orgsOf(people.ada.id);
		expect(mine).toEqual([expect.objectContaining({ slug: "ada", personal: true, role: "owner" })]);
	});

	it("makes an org with its maker as owner, in the namespace handles share", async () => {
		const acme = await orgs.createOrg(people.ada, "acme", "Acme");
		expect(acme).toMatchObject({ slug: "acme", personal: false, defaultPermission: "write" });
		expect(await orgs.roleIn(acme.id, people.ada.id)).toBe("owner");
		await expect(orgs.createOrg(people.bob, "acme")).rejects.toThrow(/\[409\]/);
		await expect(orgs.createOrg(people.bob, "ada")).rejects.toThrow(/taken/);
		for (const bad of ["fork", "a--b", "-x", "Admin", "x".repeat(40)])
			await expect(orgs.createOrg(people.bob, bad)).rejects.toThrow(/\[(400|409)\]/);
		expect(validSlug("a")).toBe(true);
	});

	it("adds a member by email: at once if they've signed in, else at first sign-in once an admin approves", async () => {
		const acme = await orgs.createOrg(people.ada, "acme");
		expect(await orgs.addMember(acme, "BOB@example.com", "member", "ada")).toEqual({ added: "bob", role: "member" });
		expect(await orgs.addMember(acme, "dan@example.com", "admin", "ada")).toEqual({
			invited: "dan@example.com",
			role: "admin",
			awaitingApproval: true,
		});
		// The org's invitations say his waits on GitHive's approval.
		expect(await orgs.invites(acme.id)).toEqual([
			{ email: "dan@example.com", role: "admin", createdAt: expect.any(String), awaitingApproval: true },
		]);
		// An org's invitation alone doesn't let dan in: it's a request the admin sees.
		const profile = { provider: "github" as const, providerId: "dan", email: "dan@example.com", login: "dan" };
		expect(await ids.signIn(profile)).toEqual({ refused: "not-invited" });
		// One request: the org's invitation, and his own try at signing in.
		const orgInvite = { org: "acme", role: "admin", invitedBy: "ada" };
		const tried = expect.objectContaining({ provider: "github", login: "dan", tries: 1 });
		expect(await ids.inviteRequests()).toEqual([
			{ email: "dan@example.com", orgs: [orgInvite], createdAt: expect.any(String), signIn: tried },
		]);
		// Approved, he signs in and joins.
		await ids.invite("dan@example.com", "admin");
		expect(await ids.inviteRequests()).toEqual([]);
		const signed = (await ids.signIn(profile)) as { user: U };
		expect(signed.user.handle).toBe("dan");
		await orgs.acceptInvites(signed.user);
		expect(await orgs.roleIn(acme.id, signed.user.id)).toBe("admin");
		expect(await orgs.invites(acme.id)).toEqual([]);
	});

	it("drops an org's request the admin turns down", async () => {
		const acme = await orgs.createOrg(people.ada, "acme");
		await orgs.addMember(acme, "zed@example.com", "member", "ada");
		await ids.declineRequest("zed@example.com");
		expect(await ids.inviteRequests()).toEqual([]);
		expect(await orgs.invites(acme.id)).toEqual([]);
	});

	it("says an invitation for someone already approved needs nothing more", async () => {
		const acme = await orgs.createOrg(people.ada, "acme");
		await ids.invite("fay@example.com", "admin");
		expect(await orgs.addMember(acme, "fay@example.com", "member", "ada")).toEqual({
			invited: "fay@example.com",
			role: "member",
		});
	});

	it("never leaves an org without an owner", async () => {
		const acme = await orgs.createOrg(people.ada, "acme");
		await expect(orgs.removeMember(acme.id, people.ada.id)).rejects.toThrow(/needs an owner/);
		await expect(orgs.setRole(acme.id, people.ada.id, "member")).rejects.toThrow(/needs an owner/);
		await orgs.addMember(acme, "bob@example.com", "owner", "ada");
		await orgs.setRole(acme.id, people.ada.id, "member");
		expect(await orgs.roleIn(acme.id, people.ada.id)).toBe("member");
	});

	it("keeps members and teams out of personal orgs", async () => {
		const ada = (await orgs.org("ada"))!;
		await expect(orgs.addMember(ada, "bob@example.com", "member", "ada")).rejects.toThrow(/personal org/);
		await expect(orgs.createTeam(ada, "core")).rejects.toThrow(/personal org/);
	});
});

describe("teams", () => {
	it("names teams as grants do, and takes only org members", async () => {
		const acme = await orgs.createOrg(people.ada, "acme");
		await orgs.addMember(acme, "bob@example.com", "member", "ada");
		expect(await orgs.createTeam(acme, "security")).toEqual({ team: "@acme/security" });
		await orgs.addTeamMember(acme.id, "security", "bob");
		await expect(orgs.addTeamMember(acme.id, "security", "eve")).rejects.toThrow(/isn't a member/);
		expect(await orgs.teamsOf(people.bob.id, acme.id)).toEqual(["@acme/security"]);
		expect(await orgs.teams(acme.id)).toEqual([expect.objectContaining({ slug: "security", members: ["bob"] })]);
		// What their vote on one of the org's repos carries; on another org's repo, nothing.
		const web = await orgs.addRepo(acme, "web", people.ada.id);
		const other = await orgs.addRepo((await orgs.org("eve"))!, "notes", people.eve.id);
		expect(await orgs.teamsForRepo(people.bob.id, web.id)).toEqual(["@acme/security"]);
		expect(await orgs.teamsForRepo(people.bob.id, other.id)).toEqual([]);
		// Leaving the org takes them off its teams.
		await orgs.removeMember(acme.id, people.bob.id);
		expect(await orgs.teamsOf(people.bob.id, acme.id)).toEqual([]);
	});
});

describe("what a person may do in a repo", () => {
	let acme: Awaited<ReturnType<OrgStore["createOrg"]>>;
	let web: Awaited<ReturnType<OrgStore["addRepo"]>>;
	beforeEach(async () => {
		acme = await orgs.createOrg(people.ada, "acme");
		await orgs.addMember(acme, "bob@example.com", "member", "ada");
		await orgs.addMember(acme, "cyd@example.com", "admin", "ada");
		web = await orgs.addRepo(acme, "web", people.ada.id);
	});

	it("names a repo <org>/<name>, and keeps it under <org>--<name>", () => {
		expect(web).toMatchObject({ id: "acme--web", fullName: "acme/web", visibility: "private" });
		expect(repoIdFor("acme", "Web")).toBe("acme--web");
	});

	it("gives owners and admins admin, members the org's default, and outsiders nothing on a private repo", async () => {
		expect(await orgs.permission(people.ada.id, web.id)).toBe("admin");
		expect(await orgs.permission(people.cyd.id, web.id)).toBe("admin");
		expect(await orgs.permission(people.bob.id, web.id)).toBe("write");
		expect(await orgs.permission(people.eve.id, web.id)).toBeNull();
		await orgs.updateOrg(acme.id, { defaultPermission: "read" });
		expect(await orgs.permission(people.bob.id, web.id)).toBe("read");
	});

	it("lets anyone read a public repo, and a collaborator do what they were given", async () => {
		await orgs.setVisibility(web.id, "public");
		expect(await orgs.permission(people.eve.id, web.id)).toBe("read");
		await orgs.setCollaborator(web.id, "eve", "review");
		expect(await orgs.permission(people.eve.id, web.id)).toBe("review");
		// The most of what applies: a member made a collaborator with less keeps the member's level.
		await orgs.setCollaborator(web.id, "bob", "read");
		expect(await orgs.permission(people.bob.id, web.id)).toBe("write");
	});

	it("lists only what each person can see", async () => {
		const ownRepo = await orgs.addRepo((await orgs.org("eve"))!, "notes", people.eve.id);
		expect((await orgs.visibleRepos(people.bob.id)).map((r) => r.fullName)).toEqual(["acme/web"]);
		expect((await orgs.visibleRepos(people.eve.id)).map((r) => r.fullName)).toEqual(["eve/notes"]);
		await orgs.setCollaborator(ownRepo.id, "bob", "write");
		expect((await orgs.visibleRepos(people.bob.id)).map((r) => r.fullName)).toEqual(["acme/web", "eve/notes"]);
	});

	it("lets members make repos only if the org allows, and owners and admins always", async () => {
		expect(await orgs.mayCreateRepo(acme, people.bob.id)).toBe(true);
		await orgs.updateOrg(acme.id, { membersCanCreateRepos: false });
		const strict = (await orgs.org("acme"))!;
		expect(await orgs.mayCreateRepo(strict, people.bob.id)).toBe(false);
		expect(await orgs.mayCreateRepo(strict, people.cyd.id)).toBe(true);
		expect(await orgs.mayCreateRepo(strict, people.eve.id)).toBe(false);
	});

	it("takes an older repo into an org under the id it already has", async () => {
		const adopted = await orgs.addRepo(acme, "legacy", null, { id: "walkthrough-01774" });
		expect(adopted).toMatchObject({ id: "walkthrough-01774", fullName: "acme/legacy" });
		await expect(orgs.addRepo(acme, "again", null, { id: "walkthrough-01774" })).rejects.toThrow(/already belongs/);
	});

	it("ranks levels", () => {
		expect(atLeast("write", "review")).toBe(true);
		expect(atLeast("review", "write")).toBe(false);
		expect(atLeast(null, "read")).toBe(false);
	});
});

describe("someone who signed in before orgs existed", () => {
	it("gets their own namespace the first time it's needed, once", async () => {
		await ids.invite("old@example.com", "admin");
		const { user } = (await ids.signIn({
			provider: "github",
			providerId: "old",
			email: "old@example.com",
			login: "old",
		})) as { user: U };
		expect(await orgs.orgsOf(user.id)).toEqual([]);
		await orgs.personalOrg(user);
		await orgs.personalOrg(user);
		expect(await orgs.orgsOf(user.id)).toEqual([
			expect.objectContaining({ slug: "old", personal: true, role: "owner" }),
		]);
	});
});
