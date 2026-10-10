import type { Hono } from "hono";
import type { Principal } from "../auth/principal";
import { resolveRepo } from "../auth/access-control";
import { type Org, OrgStore, validRepoName } from "../auth/orgs";
import { ensureRepo, forkAndWait, leftoversOf, listRepoNames, remoteFor } from "../artifacts";
import { fail } from "../errors";
import { retryTransient } from "../retry";
import { type ToolContext, callTool, openCount } from "../toolkit/mcp";
import { type InitOptions, initialFiles, parseInit, writeFirstCommit } from "../repo-init";
import type { RepoSummary } from "../repo-index";
import { rpc } from "../rpc";
import {
	type AppEnv,
	forgetRepo,
	isProject,
	jsonArgs,
	repoIndex,
	requireAccess,
	routeRepo,
	toolContext,
} from "./shared";

// A repo's life: making one (empty, imported or copied), listing the repos a caller can see, adopting one into an org,
// and deleting one with its forks and records.

/**
 * The repos a caller can see. A person or their agent sees their orgs' repos, their collaborations and public repos.
 * An Access admin sees every repo, with those outside an org named _/<id>.
 */
async function visibleRepos(env: Env, principal: Principal | undefined) {
	if (!principal) return [];
	const orgs = env.DB ? new OrgStore(env.DB) : null;
	if (principal.kind !== "access") return orgs ? await orgs.visibleRepos(principal.user.id) : [];
	const inOrgs = orgs ? await orgs.allRepos() : [];
	const ids = new Set(inOrgs.map((r) => r.id));
	const loose = (await listRepoNames(env.ARTIFACTS))
		.filter((name) => isProject(name) && !ids.has(name))
		.map((id) => ({ id, org: "_", name: id, fullName: `_/${id}`, visibility: "private" as const, createdAt: "" }));
	return [...inOrgs, ...loose];
}

/** Where a new repo's content comes from: a repo to copy, a Git URL to import, or the files of a first commit. */
interface RepoSource {
	from: unknown;
	url: unknown;
	branch: unknown;
	init: InitOptions;
}

/** Fills a new, empty repo `id` in `org` from its source. */
async function fillNewRepo(env: Env, principal: Principal, org: Org, repoName: string, id: string, source: RepoSource) {
	const { from, url, branch } = source;
	if (typeof from === "string" && from) {
		const copied = await resolveRepo(env, principal, from, "read");
		await forkAndWait(env.ARTIFACTS, copied.id, id, `A copy of ${copied.fullName}`);
		return;
	}
	if (typeof url === "string" && url) {
		await retryTransient(() =>
			env.ARTIFACTS.import({
				source: { url, branch: typeof branch === "string" ? branch : undefined },
				target: { name: id },
			}),
		);
		return;
	}
	await ensureRepo(env.ARTIFACTS, id, `${org.slug}/${repoName}`);
	// A first commit (README, .gitignore, license) gives it a main branch, so GitHive can start on it at once.
	const files = initialFiles({
		fullName: `${org.slug}/${repoName}`,
		holder: org.name ?? org.slug,
		year: new Date().getUTCFullYear(),
		...source.init,
	});
	if (Object.keys(files).length) {
		const handle = principal.kind === "access" ? "githive" : principal.user.handle;
		await writeFirstCommit(await remoteFor(env.ARTIFACTS, id, "write"), files, {
			name: handle,
			email: `${handle}@users.githive.app`,
		});
	}
}

/** One row of the dashboard's repo list, and whether GitHive has started on the repo. */
interface RepoListing {
	repo: string;
	id: string;
	since: string;
	summary: RepoSummary | null;
	started: boolean;
}

const needsRecount = (listing: RepoListing) =>
	!listing.summary?.countedAt || (listing.summary.lastActivity ?? "") > listing.summary.countedAt;

const lastActive = (listing: RepoListing) => listing.summary?.lastActivity ?? listing.since;

/** Recounts a few summaries older than their repo's last activity, the most recently active first. */
async function recountStale(index: ReturnType<typeof repoIndex>, tools: ToolContext, listings: RepoListing[]) {
	const now = new Date().toISOString();
	// The most recently active first: those are the rows people look at.
	const stale = listings
		.filter((listing) => listing.started)
		.filter(needsRecount)
		.sort((a, b) => lastActive(b).localeCompare(lastActive(a)))
		.slice(0, 3);
	await Promise.allSettled(
		stale.map(async (listing) => {
			const open = await openCount(tools, listing.id).catch(() => null);
			await index.summarize(`repo:${listing.id}`, open === null ? { countedAt: now } : { open, countedAt: now });
		}),
	);
}

export function repoRoutes(app: Hono<AppEnv>) {
	/** Imports a repo outside any org, for Access admins and their scripts. An org's repo is made with POST /repos. */
	app.post("/repos/import", async (c) => {
		requireAccess(c);
		const { url, name, branch } = await c.req.json<{ url: string; name: string; branch?: string }>();
		const imported = await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } }));
		return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
	});

	/**
	 * Makes a repo in an org or your own namespace. It is imported from a Git URL, copied from a repo you can read, or
	 * left empty. A copy takes only the default branch and is much faster than an import.
	 */
	app.post("/repos", async (c) => {
		const principal = c.get("principal") ?? fail(401, "sign in to GitHive first");
		const { owner, name, import_url: url, branch, copy_from: from, visibility, init } = await jsonArgs(c);
		const start = parseInit(init);
		if (typeof owner !== "string" || typeof name !== "string") fail(400, "owner and name are required");
		const repoName = String(name);
		if (!validRepoName(repoName))
			fail(400, "a repo's name is letters, digits, dots, underscores or single dashes, up to 100");
		const orgs = new OrgStore(c.env.DB);
		// Your own namespace exists from your first sign-in; someone who signed in before orgs existed gets it now.
		if (principal.kind !== "access" && owner === principal.user.handle) await orgs.personalOrg(principal.user);
		const org = await orgs.orgOrFail(String(owner));
		const userId = principal.kind === "access" ? null : principal.user.id;
		if (userId && !(await orgs.mayCreateRepo(org, userId))) fail(403, `you can't make repos in ${org.slug}`);
		if (await orgs.repo(org.slug, repoName)) fail(409, `${org.slug}/${repoName} exists`);
		const id = `${org.slug}--${repoName.toLowerCase()}`;
		await fillNewRepo(c.env, principal, org, repoName, id, { from, url, branch, init: start });
		const repo = await orgs.addRepo(org, repoName, userId, {
			visibility: visibility === "public" ? "public" : "private",
			id,
		});
		// GitHive starts on it at once with default settings. A repo with no branch yet starts with its first settings.
		const started = await callTool("settings", { repo: id }, toolContext(c.env, principal)).then(
			() => true,
			(err) => {
				console.error(`starting GitHive on ${org.slug}/${repoName} failed`, String(err));
				return false;
			},
		);
		return c.json({ ...repo, started }, 201);
	});

	// A new repo copied from this one, in the same namespace: for scripts (see POST /repos).
	app.post("/repos/:owner/:name/copy", async (c) => {
		const source = await routeRepo(c, "read");
		const { name } = await jsonArgs(c);
		if (typeof name !== "string" || !name) fail(400, "name the new repo");
		if (c.get("principal")?.kind === "access" && c.req.param("owner") === "_") {
			// An Access admin's copy of a repo outside any org stays outside one too.
			if (!isProject(String(name))) fail(400, "name the new repo: not a fork's or a records repo's name");
			const copied = await forkAndWait(c.env.ARTIFACTS, source.id, String(name), `A copy of ${source.fullName}`);
			return c.json({ name, remote: copied.remote });
		}
		fail(400, "copy into an org with POST /repos {owner, name, copy_from}");
	});

	// The dashboard's repo list in one read. Summaries older than a repo's last activity are recounted in the
	// background, a few per request.
	app.get("/summaries", async (c) => {
		const index = repoIndex(c.env);
		const [listed, visible] = await Promise.all([rpc(index.summaries()), visibleRepos(c.env, c.get("principal"))]);
		const summaries = new Map(listed.repos.map((row) => [row.repo, row]));
		const listings: RepoListing[] = visible.map((repo) => ({
			repo: repo.fullName,
			id: repo.id,
			since: summaries.get(repo.id)?.since ?? repo.createdAt,
			summary: summaries.get(repo.id)?.summary ?? null,
			started: summaries.has(repo.id),
		}));
		c.executionCtx.waitUntil(recountStale(index, toolContext(c.env, c.get("principal")), listings));
		return c.json({ repos: listings.map(({ started: _started, ...listing }) => listing) });
	});

	app.get("/repos", async (c) => {
		const repos = await visibleRepos(c.env, c.get("principal"));
		return c.json(
			repos
				.map((r) => ({ name: r.fullName, id: r.id, visibility: r.visibility }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		);
	});

	// Access admins list older repos outside any org and adopt one into an org with its records.
	app.get("/admin/repos", async (c) => {
		requireAccess(c);
		return c.json((await visibleRepos(c.env, c.get("principal"))).filter((r) => r.org === "_").map((r) => r.id));
	});
	app.post("/admin/repos/:id/adopt", async (c) => {
		requireAccess(c);
		const { owner, name } = await jsonArgs(c);
		const orgs = new OrgStore(c.env.DB);
		// A person's own namespace may not exist yet if they haven't signed in since orgs were added.
		const person = await orgs.userByHandle(String(owner ?? ""));
		if (person && !(await orgs.org(person.handle))) await orgs.personalOrg(person);
		const org = await orgs.orgOrFail(String(owner ?? ""));
		return c.json(await orgs.addRepo(org, String(name ?? c.req.param("id")), null, { id: c.req.param("id") }), 201);
	});

	// Delete a project repo for good, with its tokens and kept views.
	app.delete("/repos/:owner/:name", async (c) => {
		const repo = await routeRepo(c, "admin");
		const deleted = await retryTransient(() => c.env.ARTIFACTS.delete(repo.id));
		if (!deleted) return c.json({ error: `no repo ${repo.fullName}` }, 404);
		if (c.env.DB) await new OrgStore(c.env.DB).removeRepo(repo.id);
		await forgetRepo(c.env, repo.id);
		// Its agents' forks hold copies of its code and its claim shards hold its records, so they go too.
		const { forks, shards } = leftoversOf(repo.id, await listRepoNames(c.env.ARTIFACTS));
		const failed: string[] = [];
		for (const name of [...forks, ...shards])
			await retryTransient(() => c.env.ARTIFACTS.delete(name)).catch(() => failed.push(name));
		console.log("repo deleted", JSON.stringify({ repo: repo.id, forks: forks.length, shards: shards.length, failed }));
		return c.json({
			deleted: repo.fullName,
			forks: forks.length,
			shards: shards.length,
			...(failed.length ? { failed } : {}),
		});
	});
}
