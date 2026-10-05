import type { ChangeState } from "./model";

// Hash routes. Repo names may contain "/", so each segment is URI-encoded.
//   #/                                  Repositories
//   #/repos/:repo[/activity|/settings|/audit][?state=open|merged|abandoned]
//   #/repos/:repo/changes/:id[/files|/checks]
//   #/free/:repo/...                    the same, forcing coordinator-free mode
//   #/tasks/:id                         an old link; redirected to its repo

export type RepoTab = "changes" | "activity" | "settings" | "audit";
export type ChangeTab = "conversation" | "files" | "checks";
export type RepoBase = "repos" | "free";

export type Route =
	| { page: "repos" }
	| { page: "repo"; repo: string; base: RepoBase; tab: RepoTab; state: ChangeState }
	| { page: "change"; repo: string; base: RepoBase; change: string; tab: ChangeTab }
	| { page: "task"; taskId: string }
	| { page: "not-found" };

const REPO_TABS: RepoTab[] = ["changes", "activity", "settings", "audit"];
const CHANGE_TABS: ChangeTab[] = ["files", "checks"];
const STATES: ChangeState[] = ["open", "merged", "abandoned"];

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

	if (parts[0] === "tasks" && parts.length >= 2) {
		const taskId = decode(parts[1]);
		return taskId ? { page: "task", taskId } : { page: "not-found" };
	}
	if ((parts[0] === "repos" || parts[0] === "free") && parts.length >= 2) {
		const base = parts[0] as RepoBase;
		const repo = decode(parts[1]);
		if (!repo) return { page: "not-found" };
		const rest = parts.slice(2);
		if (rest.length === 0 || (rest.length === 1 && REPO_TABS.includes(rest[0] as RepoTab))) {
			const tab = (rest[0] as RepoTab | undefined) ?? "changes";
			const state = STATES.includes(params.get("state") as ChangeState) ? (params.get("state") as ChangeState) : "open";
			return { page: "repo", repo, base, tab, state };
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
	repo: (repo: string, tab: RepoTab = "changes", base: RepoBase = "repos", state: ChangeState = "open") =>
		`#/${base}/${enc(repo)}${tab === "changes" ? "" : `/${tab}`}${tab === "changes" && state !== "open" ? `?state=${state}` : ""}`,
	change: (repo: string, change: string, tab: ChangeTab = "conversation", base: RepoBase = "repos") =>
		`#/${base}/${enc(repo)}/changes/${enc(change)}${tab === "conversation" ? "" : `/${tab}`}`,
};
