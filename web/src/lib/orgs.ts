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
	const typed = repoNameTyping(name);
	if (typed) return typed;
	if (name.length > 100) return `Up to 100 characters: this one has ${name.length}.`;
	if (name === "." || name === "..") return `“${name}” can't be a name. Add a letter or a digit.`;
	return null;
}

const REPO_CHARACTER = /[A-Za-z0-9._-]/;

/** Characters a name can't have, by what people call them; any other is named itself. */
function characterName(character: string): string {
	if (/\s/.test(character)) return "Spaces aren't";
	if (character === "/") return "Slashes aren't";
	return `“${character}” isn't`;
}

/**
 * The name a repo's name might have meant: accents dropped, what it can't have turned into single dashes. None while
 * it ends in one of those (it's still being typed), or when nothing usable is left.
 */
function meantRepoName(name: string): string | null {
	const plain = name.normalize("NFD").replace(/\p{M}/gu, "");
	if (!REPO_CHARACTER.test(plain.at(-1) ?? "") || /--$/.test(plain)) return null;
	const meant = plain
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "");
	return meant && meant !== name && meant !== "." && meant !== ".." ? meant : null;
}

/**
 * What's wrong with a repo's name as it's typed: a character it can't have (named), two dashes in a row, or a dash to
 * start, with a name to use instead when there's one. Its length, and a name that's only dots, wait until the field
 * is left (repoNameProblem).
 */
export function repoNameTyping(name: string): string | null {
	const bad = [...name].find((character) => !REPO_CHARACTER.test(character));
	let problem: string | null = null;
	let otherwise = "";
	if (bad) {
		problem = `${characterName(bad)} allowed.`;
		otherwise = /\s/.test(bad) ? "Use dashes instead." : "Use letters, digits, dots, underscores and dashes.";
	} else if (name.includes("--")) problem = "No two dashes in a row.";
	else if (name.startsWith("-")) problem = "It can't start with a dash.";
	if (!problem) return null;
	const meant = meantRepoName(name);
	if (meant) return `${problem} Use ${meant}?`;
	return otherwise ? `${problem} ${otherwise}` : problem;
}

/**
 * Where a person may make a repo: their own namespace, and orgs where they're an owner or admin, or a member
 * of an org that lets members.
 */
export function creatableOwners(orgs: MyOrg[]): MyOrg[] {
	return orgs.filter(
		(org) =>
			org.personal ||
			org.role === "owner" ||
			org.role === "admin" ||
			(org.role === "member" && org.membersCanCreateRepos),
	);
}

/** The orgs proper, not a person's own namespace. */
export const realOrgs = (orgs: MyOrg[]) => orgs.filter((org) => !org.personal);

/** Owners and admins manage an org's people, teams and settings. */
export const canManage = (role: OrgRole | null | undefined) => role === "owner" || role === "admin";

/** The roles the caller may give someone: only owners make owners. */
export function assignableRoles(role: OrgRole | null | undefined): OrgRole[] {
	if (role === "owner") return ["owner", "admin", "member"];
	if (role === "admin") return ["admin", "member"];
	return [];
}

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
	return org.members.filter((member) => member.role === "owner").length > 1;
}
