import type { Context, Hono } from "hono";
import { byOf, isPerson } from "../auth/principal";
import { type Level, OrgStore } from "../auth/orgs";
import { remoteFor, reviewerName } from "../artifacts";
import { fail } from "../errors";
import {
	callTool,
	repoAudit,
	changeHistory,
	makeBranch,
	mergeAsPerson,
	repoSnapshot,
	voteAsPerson,
} from "../toolkit/mcp";
import { listTree, readFile } from "../code-browse";
import type { Timing } from "../timing";
import { defaultBranch } from "../git";
import { changeRepoName, landingLog } from "../toolkit/env";
import { leaseHeld as landingLeaseHeld } from "../toolkit/landing-lease";
import { branchHistory } from "../toolkit/history";
import type { Registry } from "../toolkit/claims";
import { GitCasLog } from "../record-log";
import { projectBranch } from "../project-branch";
import { rpc } from "../rpc";
import { keptView } from "./kept-view";
import { type AppEnv, jsonArgs, repoIndex, routeRepo, toolContext } from "./shared";

// One repo for the dashboard (/repos/:owner/:name/...): its claims, changes, landing and history, what people do there
// (vote, merge, make branches), its settings and collaborators, and its code.

export function dashboardRoutes(app: Hono<AppEnv>) {
	repoSummaryRoutes(app);
	personActionRoutes(app);
	changeViewRoutes(app);
	repoSettingsRoutes(app);
	codeRoutes(app);
}

/** The project's branch, from its claims registry. */
async function registryBranch(env: Env, repoId: string) {
	const registry = await new GitCasLog<Registry>(
		() => remoteFor(env.ARTIFACTS, repoId, "read", 3600),
		repoId,
		`refs/notes/githive-claims/${repoId}`,
	).read();
	return projectBranch(registry?.commit.state);
}

/** The repo a code route names and the ref to read: ?ref, or the repo's default branch. */
async function codeRef(c: Context<AppEnv>) {
	const repo = await routeRepo(c, "read");
	const remote = await remoteFor(c.env.ARTIFACTS, repo.id, "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return { remote, ref };
}

function repoSummaryRoutes(app: Hono<AppEnv>) {
	// A repo for the dashboard: a snapshot of its claims and votes, read from Git.
	app.get("/repos/:owner/:name", async (c) => {
		const repo = await routeRepo(c, "read");
		return keptView(c, `repo:${repo.id}`, "snapshot", 20_000, (timing) =>
			repoSnapshot({ ...toolContext(c.env, c.get("principal")), timing }, repo.id),
		);
	});
	// What the caller may do in a repo, with its id and default branch.
	app.get("/repos/:owner/:name/access", async (c) => {
		const repo = await routeRepo(c, "read");
		const [meta, branch] = await Promise.all([
			c.env.DB ? new OrgStore(c.env.DB).repoById(repo.id) : null,
			remoteFor(c.env.ARTIFACTS, repo.id, "read")
				.then(defaultBranch)
				.catch(() => null),
		]);
		return c.json({ ...repo, visibility: meta?.visibility ?? null, branch });
	});
}

function personActionRoutes(app: Hono<AppEnv>) {
	// A person's vote on a change, from the dashboard: stamped with their verified identity.
	app.post("/repos/:owner/:name/changes/:change/votes", async (c) => {
		const actor = c.get("principal") ?? fail(401, "no identity");
		if (!isPerson(actor)) fail(403, "a vote from the dashboard is a person's: agents vote through MCP");
		const repo = await routeRepo(c, "review");
		const { role, verdict, evidence } = await jsonArgs(c);
		return c.json(
			await voteAsPerson(
				toolContext(c.env, actor),
				repo.id,
				c.req.param("change"),
				{ role: String(role ?? ""), verdict: verdict as "approve" | "reject", evidence: String(evidence ?? "") },
				byOf(actor),
			),
		);
	});
	// A person merges a change from the dashboard: the same merge an agent asks for, stamped with their name.
	app.post("/repos/:owner/:name/changes/:change/merge", async (c) => {
		const actor = c.get("principal") ?? fail(401, "no identity");
		if (!isPerson(actor)) fail(403, "a merge from the dashboard is a person's: agents merge through MCP");
		const repo = await routeRepo(c, "write");
		return c.json(await mergeAsPerson(toolContext(c.env, actor), repo.id, c.req.param("change"), byOf(actor)));
	});
	// Opens the standing pull request on GitHub, or says where it is; with refresh, rewrites it (see github_pr).
	app.post("/repos/:owner/:name/github/pr", async (c) => {
		const repo = await routeRepo(c, "write");
		const { refresh } = await jsonArgs(c);
		const ctx = toolContext(c.env, c.get("principal"));
		const opened = await callTool("github_pr", { repo: repo.id, refresh: refresh === true }, ctx);
		await ctx.ping?.(repo.id).catch(() => undefined);
		return c.json(opened);
	});
	// A person makes a branch changes can land on, from another.
	app.post("/repos/:owner/:name/branches", async (c) => {
		const actor = c.get("principal") ?? fail(401, "no identity");
		if (!isPerson(actor))
			fail(403, "a branch from the dashboard is a person's: agents make one with claim (into and from)");
		const repo = await routeRepo(c, "write");
		const { name, from } = await jsonArgs(c);
		if (typeof name !== "string" || !name.trim() || typeof from !== "string" || !from.trim())
			fail(400, "a branch needs a name and the branch to make it from");
		return c.json(
			await makeBranch(toolContext(c.env, actor), repo.id, { name: name.trim(), from: from.trim() }, byOf(actor)),
		);
	});
}

function changeViewRoutes(app: Hono<AppEnv>) {
	app.get("/repos/:owner/:name/changes/:change", async (c) => {
		const repo = await routeRepo(c, "read");
		const change = c.req.param("change");
		return keptView(c, `repo:${repo.id}`, `change:${change}`, 60_000, (timing) =>
			changeHistory({ ...toolContext(c.env, c.get("principal")), timing }, repo.id, change),
		);
	});
	// The hive's recent events, newest first, for its live feed (see hive-events.ts).
	app.get("/repos/:owner/:name/events", async (c) => {
		const repo = await routeRepo(c, "read");
		const events = await rpc(c.env.REPO_CACHE.getByName(`repo:${repo.id}`).events()).catch(() => []);
		return c.json({ events: events.reverse() });
	});
	// What is being checked to land on a branch now, what landed recently (see toolkit/landing.ts), whether a merge
	// holds the landing lease, and the snapshot that check containers start from.
	app.get("/repos/:owner/:name/landing", async (c) => {
		const repo = await routeRepo(c, "read");
		// Without ?branch, use the project's branch from its claims registry.
		const branch = c.req.query("branch")?.trim() || (await registryBranch(c.env, repo.id));
		const cache = c.env.REPO_CACHE.getByName(`repo:${repo.id}`);
		const [landing, leaseHeld, forks, snapshot] = await Promise.all([
			rpc(cache.landingView(branch)).catch(() => ({ checking: null, recent: [], firstStretch: false })),
			landingLeaseHeld(landingLog(c.env, repo.id, branch)).catch(() => false),
			rpc(cache.forkQueue()).catch(() => null),
			rpc(c.env.GATE.getByName(`repo:${repo.id}`).snapshotInfo()),
		]);
		const { firstStretch, ...view } = landing;
		// A stretch worked out from outcomes kept before stretches were goes into the repo list too.
		const noted = firstStretch && "stretch" in view ? view.stretch : undefined;
		if (noted)
			await repoIndex(c.env)
				.summarize(`repo:${repo.id}`, { lastStretch: noted })
				.catch((err: unknown) => console.error(`noting ${repo.id}'s stretch failed`, String(err)));
		return c.json({ branch, leaseHeld, ...view, forks, snapshot });
	});
	app.get("/repos/:owner/:name/audit", async (c) => {
		const repo = await routeRepo(c, "read");
		return keptView(c, `repo:${repo.id}`, "audit", 5 * 60_000, (timing) =>
			repoAudit({ ...toolContext(c.env, c.get("principal")), timing }, repo.id),
		);
	});
	// The changes landed on a branch (?branch=; the project's by default), newest first, each with its intent and
	// reviews.
	app.get("/repos/:owner/:name/history", async (c) => {
		const repo = await routeRepo(c, "read");
		const branch = c.req.query("branch")?.trim() ?? "";
		const read = (timing: Timing) =>
			branchHistory({ ...toolContext(c.env, c.get("principal")), timing }, repo.id, branch);
		return keptView(c, `repo:${repo.id}`, `history:${branch}`, 60_000, read);
	});
	app.get("/repos/:owner/:name/builders/:change", async (c) => {
		const repo = await routeRepo(c, "read");
		return c.json(await rpc(c.env.BUILDER.getByName(changeRepoName(repo.id, c.req.param("change"))).state()));
	});
	// A hosted reviewer's state, by the commit it reviews (the vote's commit) and its role.
	app.get("/repos/:owner/:name/reviewers/:change/:head/:role", async (c) => {
		const repo = await routeRepo(c, "read");
		const { change, head, role } = c.req.param();
		return c.json(
			await rpc(c.env.REVIEWER.getByName(reviewerName(changeRepoName(repo.id, change), role, head)).state()),
		);
	});
	// Live updates for a repo: a WebSocket on its feed, which pings when its records change.
	app.get("/repos/:owner/:name/live", async (c) => {
		const repo = await routeRepo(c, "read");
		return c.env.REPO_CACHE.getByName(`repo:${repo.id}`).fetch(c.req.raw);
	});
}

function repoSettingsRoutes(app: Hono<AppEnv>) {
	// A repo's admins set its review policy or checks from the dashboard, through the MCP settings tool.
	app.post("/repos/:owner/:name/settings", async (c) => {
		const repo = await routeRepo(c, "admin");
		const changed = (await callTool(
			"settings",
			{ ...(await jsonArgs(c)), repo: repo.id },
			toolContext(c.env, c.get("principal")),
		)) as Record<string, unknown>;
		return c.json({ ...changed, repo: repo.fullName });
	});
	// A repo's settings: private or public (admins of the repo).
	app.patch("/repos/:owner/:name", async (c) => {
		const repo = await routeRepo(c, "admin");
		const { visibility } = await jsonArgs(c);
		const orgs = new OrgStore(c.env.DB);
		if (visibility !== undefined) await orgs.setVisibility(repo.id, visibility as "private" | "public");
		return c.json(await orgs.repoById(repo.id));
	});
	// Collaborators: people given a level in one repo (admins of the repo).
	app.get("/repos/:owner/:name/collaborators", async (c) => {
		const repo = await routeRepo(c, "admin");
		return c.json(await new OrgStore(c.env.DB).collaborators(repo.id));
	});
	app.put("/repos/:owner/:name/collaborators/:handle", async (c) => {
		const repo = await routeRepo(c, "admin");
		const { permission } = await jsonArgs(c);
		await new OrgStore(c.env.DB).setCollaborator(repo.id, c.req.param("handle"), permission as Level);
		return c.json({ collaborator: c.req.param("handle"), permission });
	});
	app.delete("/repos/:owner/:name/collaborators/:handle", async (c) => {
		const repo = await routeRepo(c, "admin");
		await new OrgStore(c.env.DB).removeCollaborator(repo.id, c.req.param("handle"));
		return c.json({ removed: c.req.param("handle") });
	});
}

// Browse a repo's code: its files, and one file's text, at a branch or commit (the repo's default branch if none).
function codeRoutes(app: Hono<AppEnv>) {
	app.get("/repos/:owner/:name/tree", async (c) => {
		const { remote, ref } = await codeRef(c);
		return c.json({ ref, ...(await listTree(remote, ref)) });
	});
	app.get("/repos/:owner/:name/file", async (c) => {
		const { remote, ref } = await codeRef(c);
		return c.json({ ref, ...(await readFile(remote, ref, c.req.query("path") ?? "")) });
	});
}
