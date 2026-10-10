import { describe, expect, it } from "vitest";
import type { MyOrg } from "../api";
import {
	addedMessage,
	assignableRoles,
	canLeave,
	canManage,
	creatableOwners,
	realOrgs,
	repoNameProblem,
	slugProblem,
} from "./orgs";
import { atLeast, canAdminister, canVote } from "./permissions";

const org = (slug: string, role: MyOrg["role"], extra: Partial<MyOrg> = {}): MyOrg => ({
	id: slug,
	slug,
	name: null,
	personal: false,
	defaultPermission: "write",
	membersCanCreateRepos: true,
	role,
	...extra,
});

describe("permission levels", () => {
	it("rank read < review < write < admin, and gate voting and settings", () => {
		expect(atLeast("write", "review")).toBe(true);
		expect(atLeast("review", "write")).toBe(false);
		expect(atLeast(undefined, "read")).toBe(false);
		expect(canVote("read")).toBe(false);
		expect(canVote("review")).toBe(true);
		expect(canAdminister("write")).toBe(false);
		expect(canAdminister("admin")).toBe(true);
	});
});

describe("orgs", () => {
	it("offers your own namespace, and orgs where you may create, as owners for a new repo", () => {
		const orgs = [
			org("ada", "owner", { personal: true }),
			org("acme", "member"),
			org("strict", "member", { membersCanCreateRepos: false }),
			org("lab", "admin"),
		];
		expect(creatableOwners(orgs).map((o) => o.slug)).toEqual(["ada", "acme", "lab"]);
		expect(realOrgs(orgs).map((o) => o.slug)).toEqual(["acme", "strict", "lab"]);
	});

	it("lets owners and admins manage, and only owners make owners", () => {
		expect(canManage("admin")).toBe(true);
		expect(canManage("member")).toBe(false);
		expect(canManage(null)).toBe(false);
		expect(assignableRoles("owner")).toEqual(["owner", "admin", "member"]);
		expect(assignableRoles("admin")).toEqual(["admin", "member"]);
		expect(assignableRoles("member")).toEqual([]);
	});

	it("lets anyone leave but an org's last owner", () => {
		const people = (roles: ("owner" | "admin" | "member")[]) =>
			roles.map((role, i) => ({ userId: `u${i}`, handle: `p${i}`, name: null, avatarUrl: null, role }));
		expect(canLeave({ role: "member", personal: false, members: people(["owner", "member"]) })).toBe(true);
		expect(canLeave({ role: "owner", personal: false, members: people(["owner", "member"]) })).toBe(false);
		expect(canLeave({ role: "owner", personal: false, members: people(["owner", "owner"]) })).toBe(true);
		expect(canLeave({ role: "owner", personal: true, members: people(["owner"]) })).toBe(false);
		expect(canLeave({ role: null, personal: false, members: [] })).toBe(false);
	});

	it("says whether someone joined or was invited", () => {
		expect(addedMessage({ added: "bob" })).toBe("bob joined.");
		expect(addedMessage({ invited: "dan@example.com" })).toBe(
			"Invited dan@example.com: they'll join when they first sign in.",
		);
		expect(addedMessage({ invited: "dan@example.com", awaitingApproval: true })).toBe(
			"Invited dan@example.com. They can sign in once a GitHive admin approves them.",
		);
	});

	it("checks names as the server does", () => {
		expect(slugProblem("acme")).toBeNull();
		expect(slugProblem("a-b")).toBeNull();
		expect(slugProblem("-a")).toMatch(/dash/);
		expect(slugProblem("a--b")).toMatch(/two dashes/);
		expect(slugProblem("Acme")).toMatch(/lowercase/);
		expect(slugProblem("x".repeat(40))).toMatch(/39/);
		expect(repoNameProblem("my.repo_1")).toBeNull();
		expect(repoNameProblem("a b")).toMatch(/Only/);
		expect(repoNameProblem("..")).toMatch(/usable/);
	});
});
