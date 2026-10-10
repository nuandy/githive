// A repo's full name is <owner>/<name>: a person's handle or an org's slug,
// then the repo. An Access admin also sees repos that aren't in an org yet,
// as _/<id>. URLs carry the two parts as two encoded segments.

export interface RepoName {
	owner: string;
	name: string;
}

/** The owner and name of a full name; a name with no owner is a repo outside any org (_). */
export function splitRepo(fullName: string): RepoName {
	const slash = fullName.indexOf("/");
	return slash < 0
		? { owner: "_", name: fullName }
		: { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** The repo's two URL segments, each encoded: "acme/web" → "acme/web", "a b/c" → "a%20b/c". */
export function repoPath(fullName: string): string {
	const { owner, name } = splitRepo(fullName);
	return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** A repo that isn't in an org yet (only Access admins see these). */
export const isLoose = (fullName: string) => splitRepo(fullName).owner === "_";
