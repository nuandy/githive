// Hash routes. A repo is two segments, its owner and its name (each URI-encoded):
//   #/[?q=<search>]                           Repositories, searched
//   #/new[?owner=<owner>]                     a new repository
//   #/inbox                                   what waits on a person, across repos
//   #/orgs                                    your organizations, and making one
//   #/orgs/:org                               an organization (or your own namespace)
//   #/repos/:owner/:name[/changes|/history|/claims|/agents|/audit|/settings][?branch=<branch>]
//                                             (the Hive tab without one)
//   #/repos/:owner/:name/settings/:section    a part of Settings (General without one)
//   #/repos/:owner/:name/changes?filter=<needs-you|in-review|…>   the Changes list narrowed
//   #/repos/:owner/:name/code[/<path>][?ref=<branch or commit>]
//   #/repos/:owner/:name/changes/:id[/commits][?decide]
//                                             (?decide: opened at its decision, to vote or answer)
//   #/settings/agents                         your agents, their tokens, and connected apps
// Inside the dashboard a repo is named by its full name, "<owner>/<name>".
//
// A view that can be linked keeps what it shows in the query: a search, a flag. Each route reads the names it knows
// (readQuery), and its link writes them back (withQuery); a name nobody reads is ignored.

import { repoPath } from "./repoName";

export type RepoTab = "hive" | "changes" | "history" | "claims" | "code" | "agents" | "settings" | "audit";
export type ChangeTab = "conversation" | "commits";
/** The parts of a repo's Settings, each on a page of its own. */
export const SETTINGS_SECTIONS = [
	"general",
	"review",
	"path-rules",
	"branch-rules",
	"checks",
	"github",
	"danger-zone",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
	| { page: "repos"; /** The repo search. */ q?: string }
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
			/** Settings tab: the part shown. */ section?: SettingsSection;
			/** Changes tab: the list's filter, when not all of them. */ filter?: string;
	  }
	| {
			page: "change";
			repo: string;
			change: string;
			tab: ChangeTab;
			/** Opened at its decision: to vote on it, or answer its agent. */ decide?: true;
	  }
	| { page: "not-found" };

const encode = encodeURIComponent;

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

/** A query's values by name: a text, absent when empty, or a flag, there or not. */
export function readQuery(query: string) {
	const params = new URLSearchParams(query);
	return {
		text: (name: string): string | undefined => params.get(name) || undefined,
		flag: (name: string): boolean => params.has(name),
	};
}

/** A link with these in its query: a text as name=value, a flag (true) as its name; what's unset, false or empty isn't. */
export function withQuery(path: string, values: Record<string, string | boolean | undefined>): string {
	const parts = Object.entries(values).flatMap(([name, value]) => {
		if (value === true) return [encode(name)];
		if (!value) return [];
		return [`${encode(name)}=${encode(value)}`];
	});
	return parts.length ? `${path}?${parts.join("&")}` : path;
}

/** Only what's set, so a route without a view's values equals one that never had them. */
const set = <T extends Record<string, unknown>>(values: T) =>
	Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== false)) as {
		[K in keyof T]?: Exclude<T[K], undefined | false>;
	};

export function parseRoute(hash: string): Route {
	const raw = hash.replace(/^#/, "");
	const [path = "", query = ""] = raw.split("?");
	const parts = path.split("/").filter(Boolean);
	const params = readQuery(query);
	if (parts.length === 0) return { page: "repos", ...set({ q: params.text("q") }) };
	if (parts[0] === "inbox" && parts.length === 1) return { page: "inbox" };
	if (parts[0] === "new" && parts.length === 1) return { page: "new-repo", ...set({ owner: params.text("owner") }) };
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
			return { page: "repo", repo, tab: "code", path: segments.join("/"), ...set({ ref: params.text("ref") }) };
		}
		if (rest[0] === "settings" && rest.length <= 2) {
			const section = (rest[1] ?? "general") as SettingsSection;
			if (!SETTINGS_SECTIONS.includes(section)) return { page: "not-found" };
			return { page: "repo", repo, tab: "settings", section };
		}
		if (rest.length === 0 || (rest.length === 1 && REPO_TABS.includes(rest[0] as RepoTab))) {
			const tab = (rest[0] as RepoTab | undefined) ?? "hive";
			return { page: "repo", repo, tab, ...set({ branch: params.text("branch"), filter: params.text("filter") }) };
		}
		if (rest[0] === "changes" && rest.length >= 2 && rest.length <= 3) {
			const change = decode(rest[1]);
			if (!change) return { page: "not-found" };
			if (rest.length === 3 && !CHANGE_TABS.includes(rest[2] as ChangeTab)) return { page: "not-found" };
			const tab = (rest[2] as ChangeTab | undefined) ?? "conversation";
			return { page: "change", repo, change, tab, ...set({ decide: params.flag("decide") || undefined }) };
		}
	}
	return { page: "not-found" };
}

function repoHref(repo: string, tab: RepoTab = "hive", branch?: string): string {
	const tabPart = tab === "hive" ? "" : `/${tab}`;
	return withQuery(`#/repos/${repoPath(repo)}${tabPart}`, { branch });
}

/** A part of a repo's Settings; General is Settings itself. */
function settingsHref(repo: string, section: SettingsSection = "general"): string {
	return `#/repos/${repoPath(repo)}/settings${section === "general" ? "" : `/${section}`}`;
}

/** The Changes list on a branch (the project's by default), narrowed by a filter (all by default). */
function changesHref(repo: string, { branch, filter }: { branch?: string; filter?: string }): string {
	return withQuery(`#/repos/${repoPath(repo)}/changes`, { branch, filter });
}

function changeHref(
	repo: string,
	change: string,
	tab: ChangeTab = "conversation",
	view: { decide?: boolean } = {},
): string {
	const tabPart = tab === "conversation" ? "" : `/${tab}`;
	return withQuery(`#/repos/${repoPath(repo)}/changes/${encode(change)}${tabPart}`, { decide: view.decide });
}

function codeHref(repo: string, path = "", ref?: string): string {
	const segments = path.split("/").filter(Boolean).map(encode).join("/");
	const pathPart = path ? `/${segments}` : "";
	return withQuery(`#/repos/${repoPath(repo)}/code${pathPart}`, { ref });
}

export const href = {
	/** Repositories, searched for `q` when given. */
	repos: (q?: string) => withQuery("#/", { q }),
	repo: repoHref,
	settings: settingsHref,
	changes: changesHref,
	change: changeHref,
	/** A file or folder in the Code tab. Each segment is encoded separately, so the path reads naturally. */
	code: codeHref,
	/** A public repo's site as its default branch has it, or as a change has it. Outside the dashboard, so no "#". */
	site: (repo: string, change?: string) => `/site/${repoPath(repo)}/${change ? `@${encode(change)}/` : ""}`,
	newRepo: (owner?: string) => withQuery("#/new", { owner }),
	orgs: () => "#/orgs",
	org: (org: string) => `#/orgs/${encode(org)}`,
	inbox: () => "#/inbox",
	agents: () => "#/settings/agents",
	admin: () => "#/admin",
};

/**
 * The Hive tab's view, in its address's query, so a link opens it as it was:
 *   #/repos/:owner/:name?window=6h&view=timeline&agent=<agent>&row=<goal>
 * the goals' time window, Story or Timeline, the agent the goals and map are filtered to, and the goal row open.
 */
export interface HiveQuery {
	/** The time window, in ms. */
	window?: number;
	view?: "story" | "timeline";
	agent?: string;
	row?: string;
}

const MINUTE = 60_000;
const HIVE_WINDOWS: Record<string, number> = {
	"15m": 15 * MINUTE,
	"30m": 30 * MINUTE,
	"1h": 60 * MINUTE,
	"6h": 6 * 60 * MINUTE,
	"24h": 24 * 60 * MINUTE,
};

/** The Hive tab's view from an address; what it doesn't know, it leaves out. */
export function hiveQuery(hash: string): HiveQuery {
	const params = new URLSearchParams(hash.split("?")[1] ?? "");
	const span = HIVE_WINDOWS[params.get("window") ?? ""];
	const view = params.get("view");
	const agent = params.get("agent");
	const row = params.get("row");
	return {
		...(span ? { window: span } : {}),
		...(view === "story" || view === "timeline" ? { view } : {}),
		...(agent ? { agent } : {}),
		...(row ? { row } : {}),
	};
}

/** An address with the Hive tab's view in its query, the rest of it as it was; what's unset is left out. */
export function withHiveQuery(hash: string, query: HiveQuery): string {
	const [path = "", search = ""] = hash.split("?");
	const params = new URLSearchParams(search);
	for (const key of ["window", "view", "agent", "row"]) params.delete(key);
	const span = Object.entries(HIVE_WINDOWS).find(([, ms]) => ms === query.window)?.[0];
	if (span) params.set("window", span);
	if (query.view) params.set("view", query.view);
	if (query.agent) params.set("agent", query.agent);
	if (query.row) params.set("row", query.row);
	const rest = params.toString();
	return rest ? `${path}?${rest}` : path;
}
