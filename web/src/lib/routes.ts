// Hash routes. Repo names may contain "/", so each segment is URI-encoded.
//   #/                                  Repositories
//   #/inbox                             what waits on a person, across repos
//   #/repos/:repo[/claims|/agents|/audit|/settings]
//   #/repos/:repo/code[/<path>][?ref=<branch or commit>]
//   #/repos/:repo/changes/:id[/commits]
//   #/free/:repo/...                    the same (older links)

export type RepoTab = "changes" | "claims" | "code" | "agents" | "settings" | "audit";
export type ChangeTab = "conversation" | "commits";
export type RepoBase = "repos" | "free";

export type Route =
	| { page: "repos" }
	| { page: "inbox" }
	| { page: "repo"; repo: string; base: RepoBase; tab: RepoTab; /** Code tab: the file or folder shown, "" for the top. */ path?: string; /** Code tab: a branch or commit other than the project's branch. */ ref?: string }
	| { page: "change"; repo: string; base: RepoBase; change: string; tab: ChangeTab }
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

	if ((parts[0] === "repos" || parts[0] === "free") && parts.length >= 2) {
		const base = parts[0] as RepoBase;
		const repo = decode(parts[1]);
		if (!repo) return { page: "not-found" };
		const rest = parts.slice(2);
		if (rest[0] === "code") {
			const segments = rest.slice(1).map(decode);
			if (segments.some((segment) => segment === null)) return { page: "not-found" };
			const ref = params.get("ref") || undefined;
			return { page: "repo", repo, base, tab: "code", path: segments.join("/"), ...(ref ? { ref } : {}) };
		}
		if (rest.length === 0 || (rest.length === 1 && REPO_TABS.includes(rest[0] as RepoTab))) {
			return { page: "repo", repo, base, tab: (rest[0] as RepoTab | undefined) ?? "changes" };
		}
		if (rest[0] === "changes" && rest.length >= 2 && rest.length <= 3) {
			const change = decode(rest[1]);
			if (!change) return { page: "not-found" };
			if (rest.length === 3 && !CHANGE_TABS.includes(rest[2] as ChangeTab)) return { page: "not-found" };
			return { page: "change", repo, base, change, tab: (rest[2] as ChangeTab | undefined) ?? "conversation" };
		}
	}
	return { page: "not-found" };
}

const enc = encodeURIComponent;

export const href = {
	repos: () => "#/",
	repo: (repo: string, tab: RepoTab = "changes", base: RepoBase = "repos") => `#/${base}/${enc(repo)}${tab === "changes" ? "" : `/${tab}`}`,
	change: (repo: string, change: string, tab: ChangeTab = "conversation", base: RepoBase = "repos") =>
		`#/${base}/${enc(repo)}/changes/${enc(change)}${tab === "conversation" ? "" : `/${tab}`}`,
	/** A file or folder in the Code tab; each path segment is encoded, so the path reads naturally in the address bar. */
	code: (repo: string, path = "", base: RepoBase = "repos", ref?: string) =>
		`#/${base}/${enc(repo)}/code${path ? `/${path.split("/").filter(Boolean).map(enc).join("/")}` : ""}${ref ? `?ref=${enc(ref)}` : ""}`,
	inbox: () => "#/inbox",
};
