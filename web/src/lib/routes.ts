// Hash routes. A repo is two segments, its owner and its name (each URI-encoded):
//   #/                                        Repositories
//   #/new[?owner=<owner>]                     a new repository
//   #/inbox                                   what waits on a person, across repos
//   #/orgs                                    your organizations, and making one
//   #/orgs/:org                               an organization (or your own namespace)
//   #/repos/:owner/:name[/changes|/history|/claims|/agents|/audit|/settings][?branch=<branch>]
//                                             (the Hive tab without one)
//   #/repos/:owner/:name/code[/<path>][?ref=<branch or commit>]
//   #/repos/:owner/:name/changes/:id[/commits][?review]
//   #/settings/agents                         your agents, their tokens, and connected apps
// Inside the dashboard a repo is named by its full name, "<owner>/<name>".

import { repoPath } from "./repoName";

export type RepoTab = "hive" | "changes" | "history" | "claims" | "code" | "agents" | "settings" | "audit";
export type ChangeTab = "conversation" | "commits";

export type Route =
	| { page: "repos" }
	| { page: "new-repo"; owner?: string }
	| { page: "orgs" }
	| { page: "org"; org: string }
	| { page: "inbox" }
	| { page: "agents-settings" }
	| { page: "admin" }
	| {
			page: "repo";
			repo: string;
			tab: RepoTab;
			/** Code tab: the file or folder shown, "" for the top. */ path?: string;
			/** Code tab: a branch or commit other than the project's branch. */ ref?: string;
			/** Changes tab: the branch shown, when not the project's. */ branch?: string;
	  }
	| { page: "change"; repo: string; change: string; tab: ChangeTab; review?: true }
	| { page: "not-found" };

const REPO_TABS: RepoTab[] = ["hive", "changes", "history", "claims", "code", "agents", "settings", "audit"];
const CHANGE_TABS: ChangeTab[] = ["commits"];

function decode(segment: string | undefined): string | null {
	if (segment === undefined) return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

export function parseRoute(hash: string): Route {
	const raw = hash.replace(/^#/, "");
	const [path = "", query = ""] = raw.split("?");
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
			const branch = params.get("branch") || undefined;
			const tab = (rest[0] as RepoTab | undefined) ?? "hive";
			return { page: "repo", repo, tab, ...(branch ? { branch } : {}) };
		}
		if (rest[0] === "changes" && rest.length >= 2 && rest.length <= 3) {
			const change = decode(rest[1]);
			if (!change) return { page: "not-found" };
			if (rest.length === 3 && !CHANGE_TABS.includes(rest[2] as ChangeTab)) return { page: "not-found" };
			const tab = (rest[2] as ChangeTab | undefined) ?? "conversation";
			return { page: "change", repo, change, tab, ...(params.has("review") ? { review: true as const } : {}) };
		}
	}
	return { page: "not-found" };
}

const encode = encodeURIComponent;

function repoHref(repo: string, tab: RepoTab = "hive", branch?: string): string {
	const tabPart = tab === "hive" ? "" : `/${tab}`;
	const query = branch ? `?branch=${encode(branch)}` : "";
	return `#/repos/${repoPath(repo)}${tabPart}${query}`;
}

function changeHref(repo: string, change: string, tab: ChangeTab = "conversation"): string {
	const tabPart = tab === "conversation" ? "" : `/${tab}`;
	return `#/repos/${repoPath(repo)}/changes/${encode(change)}${tabPart}`;
}

function codeHref(repo: string, path = "", ref?: string): string {
	const segments = path.split("/").filter(Boolean).map(encode).join("/");
	const pathPart = path ? `/${segments}` : "";
	const query = ref ? `?ref=${encode(ref)}` : "";
	return `#/repos/${repoPath(repo)}/code${pathPart}${query}`;
}

export const href = {
	repos: () => "#/",
	repo: repoHref,
	change: changeHref,
	/** A change's page, opened at its vote form. */
	review: (repo: string, change: string) => `${changeHref(repo, change)}?review`,
	/** A file or folder in the Code tab. Each segment is encoded separately, so the path reads naturally. */
	code: codeHref,
	/** A public repo's site as its default branch has it, or as a change has it. Outside the dashboard, so no "#". */
	site: (repo: string, change?: string) => `/site/${repoPath(repo)}/${change ? `@${encode(change)}/` : ""}`,
	newRepo: (owner?: string) => `#/new${owner ? `?owner=${encode(owner)}` : ""}`,
	orgs: () => "#/orgs",
	org: (org: string) => `#/orgs/${encode(org)}`,
	inbox: () => "#/inbox",
	agents: () => "#/settings/agents",
	admin: () => "#/admin",
};
