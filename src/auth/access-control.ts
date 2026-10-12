import { type Level, OrgStore, atLeast } from "./orgs";
import type { Principal } from "./principal";
import { fail } from "../errors";

// What a caller may do in a repo, checked at every route and tool. An agent has its owner's permission. An Access
// admin may do anything and may name a repo as _/<id>, which covers older repos that aren't in an org. A repo the
// caller can't see answers 404, so its name gives nothing away. Someone signed out may read a public repo.

/**
 * What each MCP tool needs. credentials needs review for a change (it writes only to the caller's own fork)
 * and read for the project alone.
 */
export const TOOL_LEVEL: Record<string, Level> = {
	claims: "read",
	backlog: "read",
	status: "read",
	audit: "read",
	credentials: "read",
	reviews: "review",
	wait: "review",
	vote: "review",
	leave_review: "review",
	claim: "write",
	release: "write",
	merge: "write",
	revert: "write",
	add_work: "write",
	ask_human: "write",
	request_review: "write",
	build: "write",
	register: "write",
	github_pr: "write",
	settings: "admin",
};

export function toolLevel(tool: string, args: Record<string, unknown>): Level {
	if (tool === "credentials" && typeof args.change === "string" && args.change) return "review";
	return TOOL_LEVEL[tool] ?? "admin";
}

export interface RepoRef {
	/** The Artifacts name, which is also the key for the repo's records. */
	id: string;
	/** <owner>/<name>, or _/<id> for a repo that isn't in an org. */
	fullName: string;
	level: Level;
}

/** The repo a caller names, if they may do `needed` in it. */
export async function resolveRepo(
	env: Env,
	principal: Principal | undefined,
	repo: string,
	needed: Level,
): Promise<RepoRef> {
	if (!principal) return publicRepo(env, repo, needed);
	const slash = repo.indexOf("/");
	const owner = slash < 0 ? "_" : repo.slice(0, slash);
	const name = slash < 0 ? repo : repo.slice(slash + 1);
	if (!name) return fail(400, `name a repo as <owner>/<name>, not ${repo}`);
	const orgs = env.DB ? new OrgStore(env.DB) : null;

	if (principal.kind === "access") {
		if (owner === "_") {
			const fullName = (await orgs?.repoById(name))?.fullName ?? `_/${name}`;
			return { id: name, fullName, level: "admin" };
		}
		const found = (await orgs?.repo(owner, name)) ?? fail(404, `no repo ${owner}/${name}`);
		return { id: found.id, fullName: found.fullName, level: "admin" };
	}

	const missing = () => fail(404, `no repo ${repo}`);
	if (owner === "_" || !orgs) return missing();
	const found = (await orgs.repo(owner, name)) ?? missing();
	const level = (await orgs.permission(principal.user.id, found.id)) ?? missing();
	if (!atLeast(level, needed)) fail(403, `you can ${level} in ${found.fullName}; this needs ${needed}`);
	return { id: found.id, fullName: found.fullName, level };
}

/**
 * A public repo, for someone signed out who only reads. Anything else asks them to sign in, whether or not the repo
 * exists, so a private repo's name gives nothing away.
 */
async function publicRepo(env: Env, repo: string, needed: Level): Promise<RepoRef> {
	const signIn = () => fail(401, "sign in to GitHive first");
	const slash = repo.indexOf("/");
	if (needed !== "read" || slash < 1 || !env.DB) return signIn();
	const found = await new OrgStore(env.DB).repo(repo.slice(0, slash), repo.slice(slash + 1));
	if (found?.visibility !== "public") return signIn();
	return { id: found.id, fullName: found.fullName, level: "read" };
}
