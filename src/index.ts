import { Hono } from "hono";
import { verifyAccessRequest } from "./access";
import type { AccessIdentity, CoordinatorHumanActions } from "./access-contract";
import { deleteReposWithPrefix, headOf, listRepoNames, parseRepoName, remoteFor, reviewerName, sliceRepoName } from "./artifacts";
import { openTaskFor, type OpenTaskInput } from "./coordinator";
import { electedForEnv, taskCoordinator } from "./elected";
import { GitCasLog, readDecisionHistory } from "./election-git";
import { PEER_LEASE_MS, openLog, type Peer } from "./peer";
import { fail, requiredPaths, requiredString, statusOf } from "./errors";
import { retryTransient } from "./retry";
import type { Limits, Review, ReviewPolicy, Task } from "./types";
import { openTaskId } from "./open-mode";
import { handleMcpBody, type McpContext } from "./mcp";
import { type FreeContext, freeAudit, freeSnapshot } from "./free/mcp";
import type { Registry } from "./free/claims";
import { Workspace } from "./git";
import { freeAgentName, freeContextFor } from "./free/env";
import { identityLabel } from "./free/stamp";

export { Builder } from "./builder";
export { Reviewer } from "./reviewer";
export { Coordinator } from "./coordinator";
export { Gate } from "./gate";
export { TaskIndex } from "./task-index";
export { Peer } from "./peer";

const app = new Hono<{ Bindings: Env; Variables: { accessIdentity: AccessIdentity } }>();

const fixedCoordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));

/** The coordinator of a task: elected for an open task, its Coordinator object for a planned one (see taskCoordinator). */
const coordinator = taskCoordinator;
const humanCoordinator = (env: Env, taskId: string) => coordinator(env, taskId) as unknown as CoordinatorHumanActions;
const taskIndex = (env: Env) => env.TASK_INDEX.getByName("all");

/** The reviewer agent of each role for one commit of a slice; state is null for agents that never ran. */
const reviewerStates = (env: Env, repo: string, roles: string[], head: string) =>
	Promise.all(roles.map(async (role) => ({ role, state: await env.REVIEWER.getByName(reviewerName(repo, role, head)).state() })));

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
			"GET  /tasks/:id/live",
			"POST /repos/import {url, name, branch?}",
			"GET  /tasks/:id",
			"GET  /tasks/:id/slices/:slice/diff",
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
	const head = (await headOf(env.ARTIFACTS, repo)) ?? fail(409, `${repo} has no commits`);
	const task = openTaskFor(id, repo, head, input);
	const log = new GitCasLog<Task>(() => remoteFor(env.ARTIFACTS, repo, "write"), id);
	await openLog(log, task, [{ commit: head, text: `Open mode started on ${repo}: agents claim their lanes as they arrive`, at: new Date().toISOString() }]);
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
	const input = { title: requiredString(body, "title"), intent: requiredString(body, "intent"), owns: requiredPaths(body, "owns"), hosted: body.hosted as boolean | undefined };
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

// Coordinator-free repos, for the dashboard: which repos, and a snapshot of one read from Git.
app.get("/free", async (c) => c.json(await taskIndex(c.env).listFree()));
app.get("/free/:repo", async (c) => c.json(await freeSnapshot(freeContext(c.env, c.get("accessIdentity")), c.req.param("repo"))));
app.get("/free/:repo/audit", async (c) => c.json(await freeAudit(freeContext(c.env, c.get("accessIdentity")), c.req.param("repo"))));
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
	});
	return result === null ? c.body(null, 202) : c.json(result);
});
app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

// Newest first, with each task's current state.
app.get("/tasks", async (c) => {
	const refs = await taskIndex(c.env).list(Number(c.req.query("limit") ?? 50));
	const tasks = await Promise.all(refs.map((r) => coordinator(c.env, r.id).state().catch(() => null)));
	return c.json(tasks.filter((t) => t !== null));
});

// Project repos, without task forks (<taskId>--...), for the dashboard's "new task" form.
// Forks far outnumber projects, so read every page.
app.get("/repos", async (c) => {
	// Not a project: a task's fork, or a coordinator-free change's fork or claim records.
	const names = (await listRepoNames(c.env.ARTIFACTS)).filter((name) => !parseRepoName(name) && !name.startsWith("free--") && !name.startsWith("free-records--"));
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
				s.reviewHead ? reviewerStates(c.env, repo, task.review.reviewers, s.reviewHead) : [],
			]);
			return { id: s.id, builder, reviewers };
		}),
	);
	return c.json({ task, agents: slices });
});

app.get("/tasks/:id", async (c) => c.json(await coordinator(c.env, c.req.param("id")).state()));

app.get("/tasks/:id/slices/:slice/diff", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).sliceDiff(slice));
});

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
	const head = task.slices.find((s) => s.id === slice)?.reviewHead;
	if (!head) return c.json([]);
	const states = await reviewerStates(c.env, sliceRepoName(id, slice), task.review.reviewers, head);
	return c.json(states.map(({ role, state }) => ({ role, head, state })));
});

app.post("/tasks/:id/slices/:slice/reviews", async (c) => {
	const { id, slice } = c.req.param();
	const review = await c.req.json<Omit<Review, "at">>();
	return c.json(await coordinator(c.env, id).submitReview(slice, review));
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

// Delete a project repo for good. Refused while any task still uses it.
app.delete("/repos/:repo", async (c) => {
	const repo = c.req.param("repo");
	const tasks = await taskIndex(c.env).onRepo(repo);
	if (tasks.length) return c.json({ error: `tasks still use ${repo}: ${tasks.map((t) => t.id).join(", ")}; delete them first` }, 409);
	const deleted = await retryTransient(() => c.env.ARTIFACTS.delete(repo));
	if (!deleted) return c.json({ error: `no repo ${repo}` }, 404);
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
