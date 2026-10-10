import type { MyOrg, OrgDetail, OrgRole } from "../api";

// Orgs as the dashboard shows them. A person's own namespace is stored as a
// "personal" org, but it is never called an org: it's "your repositories".

/** An org's or team's name: lowercase letters, digits or single dashes, not at either end, up to 39. */
export const SLUG_HINT = "Lowercase letters, digits and single dashes, up to 39, not starting or ending with a dash.";
export function slugProblem(slug: string): string | null {
	if (!slug) return "Give it a name.";
	if (slug.length > 39) return "Up to 39 characters.";
	if (!/^[a-z0-9-]+$/.test(slug)) return "Only lowercase letters, digits and dashes.";
	if (slug.startsWith("-") || slug.endsWith("-")) return "It can't start or end with a dash.";
	if (slug.includes("--")) return "No two dashes in a row.";
	return null;
}

/** A repo's name: letters, digits, dots, underscores or single dashes, up to 100. */
export function repoNameProblem(name: string): string | null {
	if (!name) return "Give it a name.";
	if (name.length > 100) return "Up to 100 characters.";
	if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Only letters, digits, dots, underscores and dashes.";
	if (name.includes("--")) return "No two dashes in a row.";
	if (name.startsWith("-") || name === "." || name === "..") return "That isn't a usable name.";
	return null;
}

/**
 * Where a person may make a repo: their own namespace, and orgs where they're an owner or admin, or a member
 * of an org that lets members.
 */
export function creatableOwners(orgs: MyOrg[]): MyOrg[] {
	return orgs.filter(
		(o) => o.personal || o.role === "owner" || o.role === "admin" || (o.role === "member" && o.membersCanCreateRepos),
	);
}

/** The orgs proper, not a person's own namespace. */
export const realOrgs = (orgs: MyOrg[]) => orgs.filter((o) => !o.personal);

/** Owners and admins manage an org's people, teams and settings. */
export const canManage = (role: OrgRole | null | undefined) => role === "owner" || role === "admin";

/** The roles the caller may give someone: only owners make owners. */
export const assignableRoles = (role: OrgRole | null | undefined): OrgRole[] =>
	role === "owner" ? ["owner", "admin", "member"] : role === "admin" ? ["admin", "member"] : [];

/** What adding someone did: they joined, or they'll join when they first sign in. */
export function addedMessage(result: { added?: string; invited?: string; awaitingApproval?: boolean }): string {
	if (result.added) return `${result.added} joined.`;
	if (result.awaitingApproval) return `Invited ${result.invited}. They can sign in once a GitHive admin approves them.`;
	return `Invited ${result.invited}: they'll join when they first sign in.`;
}

/** Whether the caller can leave: a member who isn't the org's last owner. */
export function canLeave(org: Pick<OrgDetail, "role" | "members" | "personal">): boolean {
	if (org.personal || !org.role) return false;
	if (org.role !== "owner") return true;
	return org.members.filter((m) => m.role === "owner").length > 1;
}
