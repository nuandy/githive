import { type Context, Hono } from "hono";
import { verifyAccessRequest } from "./access";
import type { AccessIdentity, CoordinatorHumanActions } from "./access-contract";
import { deleteReposWithPrefix, headOf, listRepoNames, parseRepoName, remoteFor, reviewerName, sliceRepoName, forkAndWait } from "./artifacts";
import { hostedRoles, openTaskFor, policyFor, type OpenTaskInput } from "./coordinator";
import { electedForEnv, taskCoordinator } from "./elected";
import { GitCasLog, readDecisionHistory } from "./election-git";
import { PEER_LEASE_MS, openLog, type Peer } from "./peer";
import { fail, requiredPaths, requiredString, statusOf } from "./errors";
import { retryTransient } from "./retry";
import type { Limits, Review, ReviewPolicy, Task } from "./types";
import { lastActivityOf, openTaskId, taskSummary } from "./open-mode";
import { handleMcpBody, type McpContext } from "./mcp";
import { type FreeContext, freeAudit, freeChangeHistory, freeOpenCount, freeSnapshot, freeVoteAsPerson } from "./free/mcp";
import type { Registry } from "./free/claims";
import { listTree, readFile } from "./code-browse";
import { Timing } from "./timing";
import { defaultBranch, Workspace } from "./git";
import { freeAgentName, freeContextFor } from "./free/env";
import { identityLabel } from "./free/stamp";

export { Builder } from "./builder";
export { Reviewer } from "./reviewer";
export { Coordinator } from "./coordinator";
export { Gate } from "./gate";
export { TaskIndex } from "./task-index";
export { Peer } from "./peer";
export { LiveFeed } from "./live-feed";
export { TokenCache } from "./token-cache";

type AppEnv = { Bindings: Env; Variables: { accessIdentity: AccessIdentity } };
const app = new Hono<AppEnv>();

const fixedCoordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));

/** The coordinator of a task: elected for an open task, its Coordinator object for a planned one (see taskCoordinator). */
const coordinator = taskCoordinator;
const humanCoordinator = (env: Env, taskId: string) => coordinator(env, taskId) as unknown as CoordinatorHumanActions;
const taskIndex = (env: Env) => env.TASK_INDEX.getByName("all");

/** The reviewer agent of each role for one commit of a slice; state is null for agents that never ran. */
const reviewerStates = (env: Env, repo: string, roles: string[], head: string) =>
	Promise.all(roles.map(async (role) => ({ role, state: await env.REVIEWER.getByName(reviewerName(repo, role, head)).state() })));

/** A task as the dashboard sees it: registered agents by name and date, never their keys' hashes. */
const forPeople = <T extends { agents?: Record<string, { keyHash?: string }> }>(task: T): T =>
	task.agents ? { ...task, agents: Object.fromEntries(Object.entries(task.agents).map(([name, { keyHash: _hidden, ...rest }]) => [name, rest])) } : task;

/** A JSON body as arguments to check, or none when it is missing or not JSON. */
const jsonArgs = async (c: { req: { json<T>(): Promise<T> } }) => {
	const body = await c.req.json<Record<string, unknown> | null>().catch(() => null);
	return body && typeof body === "object" ? body : {};
};

// Authenticate before routing, including GETs and requests served from the dashboard assets.
app.use("*", async (c, next) => {
	const identity = await verifyAccessRequest(c.req.raw, {
		teamDomain: c.env.ACCESS_TEAM_DOMAIN,
		audience: c.env.ACCESS_AUD,
	});
	if (!identity) return c.json({ error: "unauthorized" }, 401);
	c.set("accessIdentity", identity);
	await next();
});

app.onError((err, c) => {
	const { status, message } = statusOf(err);
	if (status >= 500) console.error("API error", err);
	return c.json({ error: message }, status as 400);
});

app.get("/api", (c) =>
	c.json({
		name: "blueprint",
		routes: [
			"GET  /            dashboard",
			"GET  /repos",
			"GET  /tasks",
			"GET  /summaries   (every repo with its counts, for the dashboard's list)",
			"GET  /tasks/:id/live",
			"POST /repos/import {url, name, branch?}",
			"GET  /tasks/:id",
			"GET  /tasks/:id/slices/:slice/diff",
			"GET  /tasks/:id/gate   (the check run in progress and the queue)",
			"GET  /repos/:repo/tree?ref=  (every file at a branch or commit)",
			"GET  /repos/:repo/file?path=&ref=  (one file's text)",
			"PATCH /tasks/:id/settings {review?, verify?, leaseMinutes?}",
			"GET  /tasks/:id/slices/:slice/builder",
			"POST /tasks/:id/slices/:slice/pushed",
			"POST /tasks/:id/slices/:slice/reviewers",
			"GET  /tasks/:id/slices/:slice/reviewers",
			"POST /tasks/:id/slices/:slice/reviews {reviewer, head, verdict, summary, evidence?}",
			"POST /tasks/:id/slices/:slice/message {message}",
			"POST /tasks/:id/slices/:slice/waive {reason}",
			"POST /tasks/:id/slices/:slice/gate",
			"POST /repos/:repo/open {verify?, review?, limits?, leaseMinutes?}",
			"POST /tasks/:id/changes {title, intent, owns, hosted?}",
			"POST /tasks/:id/changes/:slice/extend {owns}",
			"POST /tasks/:id/changes/:slice/abandon {reason}",
			"GET  /tasks/:id/claims",
			"POST /mcp (MCP front door: JSON-RPC over HTTP)",
			"GET  /tasks/:id/ledger",
			"DELETE /tasks/:id   (state, forks and dashboard entry; refused while agents work)",
			"DELETE /repos/:repo (refused while tasks use it)",
			"GET  /free         (repos in coordinator-free mode)",
			"GET  /free/:repo   (claims and votes, from Git)",
			"GET  /free/:repo/audit  (replays the records: merges and broken conventions)",
			"GET  /tasks/:id/history  (every decision in the task's log, oldest first)",
			"GET  /tasks/:id/leader  (who leads an elected task)",
			"POST /tasks/:id/leader/crash {forMs?}  (failover test: the leader stops as if its object vanished)",
			"GET  /tasks/:id/lock-stats",
			"POST /tasks/:id/lock-stats/reset",
			"(contract amendments are proposed by builders; see task.amendments)",
		],
	}),
);

app.post("/repos/import", async (c) => {
	const { url, name, branch } = await c.req.json<{ url: string; name: string; branch?: string }>();
	const imported = await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } }));
	return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
});

// A new project repo copied from another (its default branch): seconds, where importing a big project takes a minute or more.
app.post("/repos/:repo/copy", async (c) => {
	const { name } = await c.req.json<{ name: string }>();
	if (!name || !isProject(name)) fail(400, "name the new repo: not a fork's or a records repo's name");
	const copied = await forkAndWait(c.env.ARTIFACTS, c.req.param("repo"), name, `A copy of ${c.req.param("repo")}`);
	return c.json({ name, remote: copied.remote });
});

/** Open a repo for open changes, or find it already open, and list it on the dashboard. Shared by HTTP and MCP. */
async function openRepoTask(env: Env, repo: string, input: OpenTaskInput = {}): Promise<Task> {
	const id = await openTaskId(repo);
	const listed = await taskIndex(env).get(id);
	if (listed?.elected) return electedForEnv(env, id, repo, listed.leader?.name).state();
	// Opened on a fixed Coordinator, before open mode was elected: move the task
	// now. The Coordinator hands over its state and stops deciding; the elected
	// log starts from that state, on top of its ledger, so the record in Git runs on.
	if (listed) {
		const task = (await fixedCoordinator(env, id).handOver()) as unknown as Task;
		const log = new GitCasLog<Task>(() => remoteFor(env.ARTIFACTS, repo, "write"), id);
		const moved = { commit: task.anchor ?? task.baseCommit ?? "none", text: "Open mode moves to the elected coordinator: the task goes on from the fixed Coordinator's state", at: new Date().toISOString() };
		await openLog(log, task, [moved], await log.tip());
		await taskIndex(env).add({ ...listed, elected: true });
		return task;
	}
	// No coordinator to create: the task's log in Git starts with it, and the
	// first peer that needs a decision becomes its leader.
	// Changes merge into the repo's default branch, whatever it's called.
	const branch = (await defaultBranch(await remoteFor(env.ARTIFACTS, repo, "read"))) ?? fail(409, `${repo} has no commits`);
	const head = (await headOf(env.ARTIFACTS, repo, branch)) ?? fail(409, `${repo} has no commits`);
	const task = openTaskFor(id, repo, head, input, branch);
	const log = new GitCasLog<Task>(() => remoteFor(env.ARTIFACTS, repo, "write"), id);
	await openLog(log, task, [{ commit: head, text: `Open mode started on ${repo} (branch ${branch}): agents claim their lanes as they arrive`, at: new Date().toISOString() }]);
	await taskIndex(env).add({ id, repo, goal: task.goal, createdAt: task.createdAt, elected: true });
	return task;
}

// Open mode: one open task per repo, found by a stable id. Agents open changes on it and claim their lanes.
app.post("/repos/:repo/open", async (c) => {
	const body = await c.req.json<{ verify?: string[]; review?: ReviewPolicy; limits?: Partial<Limits>; leaseMinutes?: number }>().catch(() => ({}));
	return c.json(await openRepoTask(c.env, c.req.param("repo"), body), 201);
});

// Arguments are checked as the MCP tools check them, so both front doors refuse the same calls.
app.post("/tasks/:id/changes", async (c) => {
	const body = await jsonArgs(c);
	const input = { title: requiredString(body, "title"), intent: requiredString(body, "intent"), owns: requiredPaths(body, "owns"), hosted: body.hosted as boolean | undefined, agent: body.agent as string | undefined };
	return c.json(await coordinator(c.env, c.req.param("id")).openChange(input, c.get("accessIdentity")), 201);
});

app.post("/tasks/:id/changes/:slice/extend", async (c) => {
	const owns = requiredPaths(await jsonArgs(c), "owns");
	return c.json(await coordinator(c.env, c.req.param("id")).extendClaim(c.req.param("slice"), owns));
});

app.post("/tasks/:id/changes/:slice/abandon", async (c) => {
	const reason = requiredString(await jsonArgs(c), "reason");
	return c.json(await coordinator(c.env, c.req.param("id")).abandonChange(c.req.param("slice"), reason, c.get("accessIdentity")));
});

app.get("/tasks/:id/claims", async (c) => c.json(await coordinator(c.env, c.req.param("id")).claims()));

/** Coordinator-free mode's tools for this caller (an exploration; see docs/coordinator-free.md): stateless, Git only. */
const freeContext = (env: Env, identity: AccessIdentity | undefined, agentKey?: string): FreeContext =>
	freeContextFor(env, identity ? identityLabel(identity) : undefined, agentKey ? { agentKey } : {});

/** Views bigger than this aren't kept (a Durable Object value holds up to 2 MB). */
const MAX_KEPT_VIEW = 1_000_000;

/**
 * A dashboard view kept in the repo's live feed (see live-feed.ts): served as
 * kept while fresh; when stale, served as kept while one fresh build runs in
 * the background, and pages are pinged when it's ready; built now only when
 * none is kept, or the reader asks for it fresh. Server-Timing says which
 * ("view;desc=fresh|stale|built").
 */
async function keptView(c: Context<AppEnv>, key: string, name: string, maxAgeMs: number, build: (timing: Timing) => Promise<unknown>) {
	const feed = c.env.LIVE.getByName(key);
	const kept = await feed.view(name, maxAgeMs);
	const rebuild = async (timing: Timing) => {
		try {
			const json = JSON.stringify(await timing.time("total", () => build(timing)));
			if (json.length <= MAX_KEPT_VIEW) await feed.keep(name, json, kept.writes);
			else await feed.buildFailed(name);
			return json;
		} catch (err) {
			await feed.buildFailed(name).catch(() => undefined);
			throw err;
		}
	};
	const send = (json: string, timing: string) => c.body(json, 200, { "Content-Type": "application/json", "Server-Timing": timing });
	// "Cache-Control: no-cache" (say, right after the reader's own write): build it now.
	const now = /no-cache/.test(c.req.header("Cache-Control") ?? "");
	if (kept.json !== undefined && !now) {
		if (!kept.fresh && !kept.building && (await feed.startBuild(name))) c.executionCtx.waitUntil(rebuild(new Timing()).catch((err) => console.error(`rebuilding ${key} ${name} failed`, String(err))));
		return send(kept.json, `view;desc=${kept.fresh ? "fresh" : "stale"}`);
	}
	const timing = new Timing();
	await feed.startBuild(name);
	const json = await rebuild(timing);
	return send(json, `view;desc=built, ${timing.header()}`);
}

// Coordinator-free repos, for the dashboard: which repos, and a snapshot of one read from Git.
app.get("/free", async (c) => c.json(await taskIndex(c.env).listFree()));
app.get("/free/:repo", async (c) => {
	const repo = c.req.param("repo");
	return keptView(c, `free:${repo}`, "snapshot", 20_000, (timing) => freeSnapshot({ ...freeContext(c.env, c.get("accessIdentity")), timing }, repo));
});
// A person's vote on a coordinator-free change, from the dashboard: stamped with their verified identity.
app.post("/free/:repo/changes/:change/votes", async (c) => {
	const actor = c.get("accessIdentity") ?? fail(401, "no identity");
	const { role, verdict, evidence } = await jsonArgs(c);
	const repo = c.req.param("repo");
	return c.json(await freeVoteAsPerson(freeContext(c.env, actor), repo, c.req.param("change"), { role: String(role ?? ""), verdict: verdict as "approve" | "reject", evidence: String(evidence ?? "") }, identityLabel(actor)));
});
app.get("/free/:repo/changes/:change", async (c) => {
	const { repo, change } = c.req.param();
	return keptView(c, `free:${repo}`, `change:${change}`, 60_000, (timing) => freeChangeHistory({ ...freeContext(c.env, c.get("accessIdentity")), timing }, repo, change));
});
app.get("/free/:repo/audit", async (c) => {
	const repo = c.req.param("repo");
	return keptView(c, `free:${repo}`, "audit", 5 * 60_000, (timing) => freeAudit({ ...freeContext(c.env, c.get("accessIdentity")), timing }, repo));
});
app.get("/free/:repo/builders/:change", async (c) => c.json(await c.env.BUILDER.getByName(freeAgentName(c.req.param("repo"), c.req.param("change"))).state()));
// A hosted reviewer's state, by the commit it reviews (the vote's commit) and its role.
app.get("/free/:repo/reviewers/:change/:head/:role", async (c) => {
	const { repo, change, head, role } = c.req.param();
	return c.json(await c.env.REVIEWER.getByName(reviewerName(freeAgentName(repo, change), role, head)).state());
});

// The MCP front door (stateless JSON-RPC over HTTP), for agents from anywhere.
app.post("/mcp", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
	const result = await handleMcpBody(body, {
		coordinator: (id) => coordinator(c.env, id) as unknown as ReturnType<McpContext["coordinator"]>,
		openRepo: (repo) => openRepoTask(c.env, repo),
		free: freeContext(c.env, c.get("accessIdentity"), c.req.header("X-Blueprint-Agent-Key")),
		identity: c.get("accessIdentity"),
		agentKey: c.req.header("X-Blueprint-Agent-Key") || undefined,
		forkRead: async (repo) => {
			const remote = await remoteFor(c.env.ARTIFACTS, repo, "read", 3 * 3600);
			return { url: remote.url, token: remote.token };
		},
	});
	return result === null ? c.body(null, 202) : c.json(result);
});
app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

// Newest first, with each task's current state.
app.get("/tasks", async (c) => {
	const refs = await taskIndex(c.env).list(Number(c.req.query("limit") ?? 50));
	const tasks = await Promise.all(refs.map((r) => coordinator(c.env, r.id).state().catch(() => null)));
	return c.json(tasks.filter((t) => t !== null).map(forPeople));
});

// The dashboard's list of repos in one read: every task and coordinator-free
// repo with its summary. Summaries missing or older than the repo's last
// activity are counted again in the background, a few per request.
app.get("/summaries", async (c) => {
	const index = taskIndex(c.env);
	const listed = await index.summaries();
	const now = new Date().toISOString();
	const tasks = listed.tasks.filter((t) => !t.summary?.countedAt).slice(0, 5);
	// The most recently active first: those are the rows people look at.
	const free = listed.free
		.filter((r) => !r.summary?.countedAt || (r.summary.lastActivity ?? "") > r.summary.countedAt)
		.sort((a, b) => (b.summary?.lastActivity ?? b.since).localeCompare(a.summary?.lastActivity ?? a.since))
		.slice(0, 3);
	const ctx = freeContext(c.env, c.get("accessIdentity"));
	c.executionCtx.waitUntil(
		Promise.allSettled([
			...tasks.map(async (t) => {
				// A task whose state can't be read is marked counted, so it isn't tried on every request.
				const task = (await coordinator(c.env, t.id).state().catch(() => null)) as unknown as Task | null;
				await index.summarize(`task:${t.id}`, task ? taskSummary(task, now, lastActivityOf(task)) : { countedAt: now });
			}),
			...free.map(async (r) => {
				const open = await freeOpenCount(ctx, r.repo).catch(() => null);
				await index.summarize(`free:${r.repo}`, open === null ? { countedAt: now } : { open, countedAt: now });
			}),
		]),
	);
	return c.json(listed);
});

// Project repos, without task forks (<taskId>--...), for the dashboard's "new task" form.
// Forks far outnumber projects, so read every page.
/** Not a project: a task's fork, or a coordinator-free change's fork or claim records. */
const isProject = (name: string) => !parseRepoName(name) && !/^[0-9a-f]{8}--agent--/.test(name) && !name.startsWith("free--") && !name.startsWith("free-records--");

/** A deleted project's tokens and kept dashboard views go with it, so a new repo by its name starts clean. */
async function forgetRepo(env: Env, repo: string) {
	await Promise.resolve()
		.then(() => Promise.all([env.TOKENS?.getByName(repo).clear(), env.LIVE?.getByName(`free:${repo}`).clearViews()]))
		.catch((err) => console.error(`forgetting ${repo}'s tokens and views failed`, String(err)));
}

app.get("/repos", async (c) => {
	const names = (await listRepoNames(c.env.ARTIFACTS)).filter(isProject);
	return c.json(names.sort().map((name) => ({ name })));
});

/**
 * Everything the dashboard shows for one task, in one request: the task, each
 * slice's builder, the reviewers of each slice's current review commit, and
 * the gate. Agents that never ran are null.
 */
app.get("/tasks/:id/live", async (c) => {
	const id = c.req.param("id");
	const task = await coordinator(c.env, id).state();
	const slices = await Promise.all(
		task.slices.map(async (s) => {
			const repo = sliceRepoName(id, s.id);
			const [builder, reviewers] = await Promise.all([
				c.env.BUILDER.getByName(repo).state(),
				s.reviewHead ? reviewerStates(c.env, repo, hostedRoles(policyFor(task as unknown as Task, s as unknown as Task["slices"][number])), s.reviewHead) : [],
			]);
			return { id: s.id, builder, reviewers };
		}),
	);
	return c.json({ task: forPeople(task), agents: slices });
});

app.get("/tasks/:id", async (c) => c.json(forPeople(await coordinator(c.env, c.req.param("id")).state())));

// A person changes a repo's settings from the dashboard: review policy, checks, claim lease.
app.patch("/tasks/:id/settings", async (c) => {
	const body = await jsonArgs(c);
	const input = {
		...(body.review !== undefined ? { review: body.review as ReviewPolicy } : {}),
		...(body.verify !== undefined ? { verify: body.verify as string[] } : {}),
		...(body.leaseMinutes !== undefined ? { leaseMinutes: body.leaseMinutes as number } : {}),
	};
	return c.json(await coordinator(c.env, c.req.param("id")).updateSettings(input, c.get("accessIdentity")));
});

app.get("/tasks/:id/slices/:slice/diff", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).sliceDiff(slice));
});

// The task's gate: the run in progress and what's queued.
app.get("/tasks/:id/gate", async (c) => c.json(await c.env.GATE.getByName(c.req.param("id")).state()));

app.get("/tasks/:id/slices/:slice/builder", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await c.env.BUILDER.getByName(sliceRepoName(id, slice)).state());
});

// Builder agents call this after each push. Runs Merge-ahead.
app.post("/tasks/:id/slices/:slice/pushed", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).recordPush(slice));
});

// Starts hosted reviewer agents (one container per role). Builders do this on finish.
app.post("/tasks/:id/slices/:slice/reviewers", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).startReviewers(slice), 202);
});

// Reviewers of the slice's current review commit.
app.get("/tasks/:id/slices/:slice/reviewers", async (c) => {
	const { id, slice } = c.req.param();
	const task = await coordinator(c.env, id).state();
	const found = task.slices.find((s) => s.id === slice);
	const head = found?.reviewHead;
	if (!found || !head) return c.json([]);
	const states = await reviewerStates(c.env, sliceRepoName(id, slice), hostedRoles(policyFor(task as unknown as Task, found as unknown as Task["slices"][number])), head);
	return c.json(states.map(({ role, state }) => ({ role, head, state })));
});

// An outside reviewer's verdict, as the caller's Access identity (agents use submit_review over MCP, with their key).
// Blueprint's own reviewers vote from inside, never through here.
app.post("/tasks/:id/slices/:slice/reviews", async (c) => {
	const { id, slice } = c.req.param();
	const { reviewer, head, verdict, summary, evidence } = await c.req.json<Omit<Review, "at" | "by">>();
	const actor = c.get("accessIdentity") ?? fail(401, "no identity");
	return c.json(await coordinator(c.env, id).submitExternalReview(slice, { reviewer, head, verdict, summary, ...(evidence ? { evidence } : {}) }, identityLabel(actor)));
});

// A human messages a slice's builder: delivered at its next turn, or it resumes if it stopped.
app.post("/tasks/:id/slices/:slice/message", async (c) => {
	const { id, slice } = c.req.param();
	const { message } = await c.req.json<{ message: string }>();
	return c.json(await humanCoordinator(c.env, id).messageBuilder(slice, message, c.get("accessIdentity")));
});

// A human lets the current review commit through without an approved quorum (recorded; the gate still runs).
app.post("/tasks/:id/slices/:slice/waive", async (c) => {
	const { id, slice } = c.req.param();
	const { reason } = await c.req.json<{ reason: string }>();
	return c.json(await humanCoordinator(c.env, id).waive(slice, { reason }, c.get("accessIdentity")));
});

// Re-run the integration gate for an approved slice (for example after fixing the task base).
app.post("/tasks/:id/slices/:slice/gate", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await humanCoordinator(c.env, id).retryGate(slice, c.get("accessIdentity")), 202);
});

// Lock timings for benchmarks; POST clears them after reading.
// A task's history: every decision in its log in Git, oldest first (none for a task not run by the elected coordinator).
app.get("/tasks/:id/history", async (c) => {
	const ref = await taskIndex(c.env).get(c.req.param("id"));
	if (!ref) fail(404, `no task ${c.req.param("id")}`);
	const entries = ref.elected ? await readDecisionHistory(await remoteFor(c.env.ARTIFACTS, ref.repo, "read"), ref.id) : [];
	return c.json({ entries });
});

// Who leads an elected task, as the task index notes it (null: nobody, as far as it knows).
app.get("/tasks/:id/leader", async (c) => {
	const leader = (await taskIndex(c.env).get(c.req.param("id")))?.leader;
	return c.json({ leader: leader?.name ?? null, term: leader?.term ?? 0 });
});

// Failover tests: the leader the task index names stops as if its object vanished, for forMs (default two leases).
app.post("/tasks/:id/leader/crash", async (c) => {
	const id = c.req.param("id");
	const body = await jsonArgs(c);
	const forMs = typeof body.forMs === "number" && body.forMs > 0 ? body.forMs : 2 * PEER_LEASE_MS;
	const leader = (await taskIndex(c.env).get(id))?.leader;
	if (!leader?.name) fail(409, `nobody leads ${id}`);
	await (c.env.PEER.getByName(leader.name) as unknown as Peer).simulateCrash(forMs);
	return c.json({ crashed: leader.name, term: leader.term, forMs });
});

app.get("/tasks/:id/lock-stats", async (c) => c.json(await coordinator(c.env, c.req.param("id")).lockStats()));
app.post("/tasks/:id/lock-stats/reset", async (c) => c.json(await coordinator(c.env, c.req.param("id")).lockStats(true)));

// Delete a task for good: its state, its forks (repos named <task>--…) and its dashboard entry.
// Refused while agents are at work on it. The project repo is left alone.
app.delete("/tasks/:id", async (c) => {
	const id = c.req.param("id");
	if (!/^[0-9a-f]{8}$/.test(id)) return c.json({ error: "not a task id" }, 400);
	const destroyed = await coordinator(c.env, id).destroy();
	const forks = await deleteReposWithPrefix(c.env.ARTIFACTS, `${id}--`);
	const listed = await taskIndex(c.env).remove(id);
	console.log("task deleted", JSON.stringify({ id, repo: destroyed.repo, forks: forks.length, listed }));
	return c.json({ deleted: id, repo: destroyed.repo, forks, listed });
});

// Bench only (BENCH_WIPE, set in wrangler.bench.jsonc and never on production):
// delete every repo in the namespace, a batch per call (a request can make only
// so many subrequests), and forget every task and repo the dashboard lists.
// Call again until nothing remains.
const WIPE_CONFIRMATION = "delete every repo in the bench namespace";
const WIPE_BATCH = 400;
const WIPE_PARALLEL = 8;
app.post("/admin/wipe", async (c) => {
	if ((c.env as unknown as { BENCH_WIPE?: string }).BENCH_WIPE !== "allowed") return c.json({ error: "not available here" }, 404);
	const { confirm, batch: size } = await jsonArgs(c);
	if (confirm !== WIPE_CONFIRMATION) return c.json({ error: `confirm with "${WIPE_CONFIRMATION}"` }, 400);
	await taskIndex(c.env).clear();
	const names = await listRepoNames(c.env.ARTIFACTS);
	const batch = names.slice(0, typeof size === "number" && size > 0 ? Math.min(size, WIPE_BATCH) : WIPE_BATCH);
	const failed: string[] = [];
	// A few at a time: one by one, a batch outlasts the caller's patience.
	for (let i = 0; i < batch.length; i += WIPE_PARALLEL)
		await Promise.all(batch.slice(i, i + WIPE_PARALLEL).map((name) => retryTransient(() => c.env.ARTIFACTS.delete(name)).then(() => (isProject(name) ? forgetRepo(c.env, name) : undefined)).catch(() => failed.push(name))));
	console.log("bench wipe", JSON.stringify({ deleted: batch.length - failed.length, failed: failed.length, remaining: names.length - batch.length }));
	return c.json({ deleted: batch.length - failed.length, failed, remaining: names.length - batch.length + failed.length });
});

// Live updates: a page opens a WebSocket on its repo's feed ("task:<id>" or "free:<repo>") and refreshes when pinged.
app.get("/live/:key", async (c) => {
	const key = c.req.param("key");
	if (!/^(task:[0-9a-f]{8}|free:[A-Za-z0-9._-]+)$/.test(key)) return c.json({ error: "not a feed" }, 400);
	return c.env.LIVE.getByName(key).fetch(c.req.raw);
});

// Browse a repo's code: its files, and one file's text, at a branch or commit (the repo's default branch if none).
app.get("/repos/:repo/tree", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, c.req.param("repo"), "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await listTree(remote, ref)) });
});
app.get("/repos/:repo/file", async (c) => {
	const remote = await remoteFor(c.env.ARTIFACTS, c.req.param("repo"), "read");
	const ref = c.req.query("ref") || ((await defaultBranch(remote)) ?? fail(404, "the repo has no commits"));
	return c.json({ ref, ...(await readFile(remote, ref, c.req.query("path") ?? "")) });
});

// Delete a project repo for good. Refused while any task still uses it.
app.delete("/repos/:repo", async (c) => {
	const repo = c.req.param("repo");
	const tasks = await taskIndex(c.env).onRepo(repo);
	if (tasks.length) return c.json({ error: `tasks still use ${repo}: ${tasks.map((t) => t.id).join(", ")}; delete them first` }, 409);
	const deleted = await retryTransient(() => c.env.ARTIFACTS.delete(repo));
	if (!deleted) return c.json({ error: `no repo ${repo}` }, 404);
	await forgetRepo(c.env, repo);
	console.log("repo deleted", repo);
	return c.json({ deleted: repo });
});

// The task's record in Git: rebuild it from the notes ref and compare with the stored state.
app.get("/tasks/:id/ledger", async (c) => c.json(await coordinator(c.env, c.req.param("id")).ledger()));

// Everything that isn't an API route is the dashboard.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

interface ArtifactsEvent {
	type: string;
	source: { namespace: string; repoName: string };
}

export default {
	fetch: app.fetch,

	/**
	 * Artifacts event subscriptions. `pushed` is a per-repo event, so slice forks
	 * created at runtime aren't covered by a static subscription; builder agents
	 * report pushes through the HTTP route above. This handler covers any repo
	 * that does have a subscription.
	 */
	async queue(batch: MessageBatch<ArtifactsEvent>, env: Env) {
		for (const message of batch.messages) {
			const event = message.body;
			const target = parseRepoName(event.source?.repoName ?? "");
			if (event.type === "cf.artifacts.repo.pushed" && target) {
				try {
					await coordinator(env, target.taskId).recordPush(target.slice);
				} catch (err) {
					console.error("recordPush failed", event.source.repoName, statusOf(err).message, err);
				}
			}
			message.ack();
		}
	},
} satisfies ExportedHandler<Env, ArtifactsEvent>;
