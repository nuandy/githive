// Hash routes. A repo is two segments, its owner and its name (each URI-encoded):
//   #/                                        Repositories
//   #/new[?owner=<owner>]                     a new repository
//   #/inbox                                   what waits on a person, across repos
//   #/orgs                                    your organizations, and making one
//   #/orgs/:org                               an organization (or your own namespace)
//   #/repos/:owner/:name[/claims|/agents|/audit|/settings]
//   #/repos/:owner/:name/code[/<path>][?ref=<branch or commit>]
//   #/repos/:owner/:name/changes/:id[/commits]
//   #/settings/agents                         your agents, their tokens, and connected apps
// Inside the dashboard a repo is named by its full name, "<owner>/<name>".

import { repoPath } from "./repoName";

export type RepoTab = "changes" | "claims" | "code" | "agents" | "settings" | "audit";
export type ChangeTab = "conversation" | "commits";

export type Route =
	| { page: "repos" }
	| { page: "new-repo"; owner?: string }
	| { page: "orgs" }
	| { page: "org"; org: string }
	| { page: "inbox" }
	| { page: "agents-settings" }
	| { page: "admin" }
	| { page: "repo"; repo: string; tab: RepoTab; /** Code tab: the file or folder shown, "" for the top. */ path?: string; /** Code tab: a branch or commit other than the project's branch. */ ref?: string }
	| { page: "change"; repo: string; change: string; tab: ChangeTab }
	| { page: "not-found" };

const REPO_TABS: RepoTab[] = ["changes", "claims", "code", "agents", "settings", "audit"];
const CHANGE_TABS: ChangeTab[] = ["commits"];

function decode(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

export function parseRoute(hash: string): Route {
	const raw = hash.replace(/^#/, "");
	const [path, query = ""] = raw.split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 0) return { page: "repos" };
	const params = new URLSearchParams(query);
	if (parts[0] === "inbox" && parts.length === 1) return { page: "inbox" };
	if (parts[0] === "new" && parts.length === 1) {
		const owner = params.get("owner") || undefined;
		return { page: "new-repo", ...(owner ? { owner } : {}) };
	}
	if (parts[0] === "orgs" && parts.length === 1) return { page: "orgs" };
	if (parts[0] === "orgs" && parts.length === 2) {
		const org = decode(parts[1]);
		return org ? { page: "org", org } : { page: "not-found" };
	}
	if (parts[0] === "settings" && parts[1] === "agents" && parts.length === 2) return { page: "agents-settings" };
	if (parts[0] === "admin" && parts.length === 1) return { page: "admin" };

	if (parts[0] === "repos" && parts.length >= 3) {
		const owner = decode(parts[1]);
		const name = decode(parts[2]);
		if (!owner || !name) return { page: "not-found" };
		const repo = `${owner}/${name}`;
		const rest = parts.slice(3);
		if (rest[0] === "code") {
			const segments = rest.slice(1).map(decode);
			if (segments.some((segment) => segment === null)) return { page: "not-found" };
			const ref = params.get("ref") || undefined;
			return { page: "repo", repo, tab: "code", path: segments.join("/"), ...(ref ? { ref } : {}) };
		}
		if (rest.length === 0 || (rest.length === 1 && REPO_TABS.includes(rest[0] as RepoTab))) {
			return { page: "repo", repo, tab: (rest[0] as RepoTab | undefined) ?? "changes" };
		}
		if (rest[0] === "changes" && rest.length >= 2 && rest.length <= 3) {
			const change = decode(rest[1]);
			if (!change) return { page: "not-found" };
			if (rest.length === 3 && !CHANGE_TABS.includes(rest[2] as ChangeTab)) return { page: "not-found" };
			return { page: "change", repo, change, tab: (rest[2] as ChangeTab | undefined) ?? "conversation" };
		}
	}
	return { page: "not-found" };
}

const enc = encodeURIComponent;

export const href = {
	repos: () => "#/",
	repo: (repo: string, tab: RepoTab = "changes") => `#/repos/${repoPath(repo)}${tab === "changes" ? "" : `/${tab}`}`,
	change: (repo: string, change: string, tab: ChangeTab = "conversation") =>
		`#/repos/${repoPath(repo)}/changes/${enc(change)}${tab === "conversation" ? "" : `/${tab}`}`,
	/** A file or folder in the Code tab; each path segment is encoded, so the path reads naturally in the address bar. */
	code: (repo: string, path = "", ref?: string) =>
		`#/repos/${repoPath(repo)}/code${path ? `/${path.split("/").filter(Boolean).map(enc).join("/")}` : ""}${ref ? `?ref=${enc(ref)}` : ""}`,
	newRepo: (owner?: string) => `#/new${owner ? `?owner=${enc(owner)}` : ""}`,
	orgs: () => "#/orgs",
	org: (org: string) => `#/orgs/${enc(org)}`,
	inbox: () => "#/inbox",
	agents: () => "#/settings/agents",
	admin: () => "#/admin",
};
