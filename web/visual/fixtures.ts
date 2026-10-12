// Synthetic, deterministic answers to every request the dashboard makes, for the visual regression check
// (capture.ts). Nothing here is production data: the people, repos and changes are invented, every time counts back
// from FIXED_NOW, and nothing is random.
//
// The repos, each showing different states:
//   acme/storefront      public, busy: a change in every state, a landing batch, audit findings, hosted agents
//   robin/notes          the admin's own, private: two changes at work, nothing needing a person
//   acme/docs            private: no claims, its last stretch of work landed an hour ago ("just finished")
//   acme/new-thing       private: made minutes ago, no commits, GitHive not started on it
//   oss-friend/tiny-lib  someone else's public repo the admin can only read, quiet for days

import type { RepoAccess } from "../src/api.ts";
import type { Summaries } from "../src/lib/repos.ts";
import {
	AGENTS,
	APPROVED,
	CONNECTIONS,
	HOSTED_USERS,
	ME,
	MY_ORGS,
	OPERATOR,
	REQUESTS,
	orgDetails,
} from "./fixtures/account.ts";
import { fileAt } from "./fixtures/files.ts";
import type { RepoFixture } from "./fixtures/repo.ts";
import { DOCS_REPO, NEW_THING, NOTES_REPO, TINY_LIB } from "./fixtures/small-repos.ts";
import { STOREFRONT } from "./fixtures/storefront.ts";

export { FIXED_NOW } from "./fixtures/clock.ts";

/**
 * Who is asking: the signed-in admin (a person who owns the acme org), someone signed out, or one of GitHive's
 * operators through Cloudflare Access (the only caller the Admin page is for; otherwise they see what the admin sees).
 */
export type Who = "admin" | "visitor" | "operator";

export interface Answer {
	status: number;
	body: unknown;
}

const REPOS: RepoFixture[] = [STOREFRONT, NOTES_REPO, DOCS_REPO, NEW_THING, TINY_LIB];
const ORGS = orgDetails(REPOS);

const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string): Answer => ({ status, body: { error } });
const signIn = () => fail(401, "sign in to GitHive first");

function decode(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/** The answer to one API request, or null when this module doesn't know the route. */
export function answer(method: string, url: URL, who: Who): Answer | null {
	if (method.toUpperCase() !== "GET") return { status: 200, body: {} };
	const decoded = url.pathname.split("/").filter(Boolean).map(decode);
	if (decoded.some((part) => part === null)) return null;
	const parts = decoded as string[];
	const [first, second, ...rest] = parts;
	const visitor = who === "visitor";

	switch (first) {
		case "me":
			return meAnswer(second, rest, who);
		case "auth":
			return second === "providers" && !rest.length ? ok({ providers: ["github", "google"], inviteCode: true }) : null;
		case "summaries":
			if (second !== undefined) return null;
			return visitor ? signIn() : ok(summaries());
		case "repos":
			if (second === undefined) return visitor ? signIn() : ok(repoList());
			if (rest[0] === undefined) return null;
			return repoAnswer(second, rest[0], rest.slice(1), url.searchParams, who);
		case "orgs":
			if (visitor) return signIn();
			if (second === undefined) return ok(who === "operator" ? [] : MY_ORGS);
			if (rest.length) return null;
			return ORGS[second] ? ok(ORGS[second]) : fail(404, `no org ${second}`);
		case "admin":
			return adminAnswer(second, rest, who);
		case "demo":
			if (second !== "runs") return null;
			if (!rest.length) return ok({ running: null, recent: [], newest: null });
			if (rest.length === 2) return fail(404, `no demo run on ${rest[0]}/${rest[1]}`);
			return null;
		default:
			return null;
	}
}

function meAnswer(second: string | undefined, rest: string[], who: Who): Answer | null {
	if (rest.length) return null;
	if (who === "visitor") return second === undefined ? fail(401, "signed out") : signIn();
	if (second === undefined) return ok(who === "operator" ? OPERATOR : ME);
	if (second !== "agents" && second !== "connections") return null;
	if (who === "operator") return fail(403, "agents belong to people signed in to GitHive");
	return ok(second === "agents" ? AGENTS : CONNECTIONS);
}

function adminAnswer(second: string | undefined, rest: string[], who: Who): Answer | null {
	if (rest.length) return null;
	const lists: Record<string, unknown> = {
		invites: APPROVED,
		"invite-requests": REQUESTS,
		"hosted-agents": HOSTED_USERS,
	};
	if (second === undefined || !(second in lists)) return null;
	return who === "visitor" ? signIn() : ok(lists[second]);
}

/** Every repo the admin can see, with its counts: the Repositories list and the Inbox. */
function summaries(): Summaries {
	return {
		repos: REPOS.map((repo) => ({
			repo: repo.fullName,
			id: repo.id,
			since: repo.createdAt,
			summary: repo.summary,
			...(repo.others ? { public: true } : {}),
		})),
	};
}

function repoList() {
	return REPOS.map((repo) => ({ name: repo.fullName, id: repo.id, visibility: repo.visibility }));
}

function repoAnswer(owner: string, name: string, rest: string[], query: URLSearchParams, who: Who): Answer | null {
	const fullName = `${owner}/${name}`;
	const repo = REPOS.find((each) => each.fullName === fullName);
	// Someone signed out is asked to sign in for any repo but a public one, so a private repo's name gives nothing away.
	if (!repo) return who === "visitor" ? signIn() : fail(404, `no repo ${fullName}`);
	if (who === "visitor" && repo.visibility !== "public") return signIn();
	const level = who === "operator" ? "admin" : who === "visitor" ? "read" : repo.level;
	const notStarted = () => fail(404, `GitHive hasn't started on ${fullName}`);
	const hive = repo.hive;
	const [what, id, ...more] = rest;

	if (what === undefined) return hive ? ok(hive.snapshot) : notStarted();
	if (what === "changes") {
		if (id === undefined || more.length) return null;
		if (!hive) return notStarted();
		const change = hive.changes.get(id);
		return change ? ok(change) : fail(404, `no change ${id} on ${fullName}`);
	}
	if (id !== undefined) return null;
	switch (what) {
		case "access": {
			const access: RepoAccess = {
				id: repo.id,
				fullName,
				level,
				visibility: repo.visibility,
				branch: repo.branch,
			};
			return ok(access);
		}
		case "audit":
			return hive ? ok(hive.audit) : fail(409, `GitHive hasn't started on ${fullName}`);
		case "history": {
			if (!hive) return notStarted();
			const branch = query.get("branch")?.trim() || repo.branch || "main";
			const history = hive.histories[branch];
			return history ? ok(history) : fail(404, `no branch ${branch}`);
		}
		case "landing": {
			if (!hive) return notStarted();
			const branch = query.get("branch")?.trim() || repo.branch || "main";
			return ok(hive.landings[branch] ?? { branch, checking: null, recent: [] });
		}
		case "events":
			return ok({ events: hive?.events ?? [] });
		case "tree":
		case "file":
			return codeAnswer(repo, what, query);
		case "hosted-agents":
			return ok(repo.hosted);
		case "collaborators":
			if (who === "visitor") return signIn();
			if (level !== "admin") return fail(403, `you can ${level} in ${fullName}; this needs admin`);
			return ok(repo.collaborators);
		default:
			return null;
	}
}

/** A repo's files, or one file's text, at a branch or a commit (its default branch if none). */
function codeAnswer(repo: RepoFixture, what: "tree" | "file", query: URLSearchParams): Answer {
	if (!repo.branch) return fail(404, "the repo has no commits");
	const ref = query.get("ref") || repo.branch;
	const commit = /^[0-9a-f]{40}$/.test(ref) ? ref : repo.heads[ref];
	if (!commit) return fail(404, `no branch ${ref}`);
	if (what === "tree") return ok({ ref, commit, files: repo.files, truncated: false });
	const path = query.get("path") ?? "";
	if (!path || path.startsWith("/") || path.split("/").includes(".."))
		return fail(400, "path must be a file in the repo");
	if (!repo.files.includes(path)) return fail(404, `no file ${path} at ${commit.slice(0, 8)}`);
	return ok(fileAt(repo.fullName, path, ref, commit));
}
