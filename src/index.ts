import { Hono } from "hono";
import { verifyAccessRequest } from "./access";
import type { AccessIdentity, CoordinatorHumanActions } from "./access-contract";
import { forkAndWait, parseRepoName, remoteFor, reviewerName } from "./artifacts";
import { statusOf } from "./errors";
import { retryTransient } from "./retry";
import { Workspace } from "./git";
import type { Blueprint, Limits, Review, ReviewPolicy } from "./types";
import { openTaskId } from "./open-mode";
import { handleMcpBody, type McpContext } from "./mcp";

export { Builder } from "./builder";
export { Reviewer } from "./reviewer";
export { Coordinator } from "./coordinator";
export { ContractChecker } from "./contract-check";
export { Gate } from "./gate";
export { TaskIndex } from "./task-index";

const app = new Hono<{ Bindings: Env; Variables: { accessIdentity: AccessIdentity } }>();

const coordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));
const humanCoordinator = (env: Env, taskId: string) => coordinator(env, taskId) as unknown as CoordinatorHumanActions;
const taskIndex = (env: Env) => env.TASK_INDEX.getByName("all");

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
			"POST /spike",
			"POST /repos/import {url, name, branch?}",
			"POST /tasks {repo, goal, limits?: {builders, reviewers}}",
			"GET  /tasks/:id",
			"GET  /tasks/:id/contracts",
			"GET  /tasks/:id/slices/:slice/diff",
			"GET  /tasks/:id/land-diff",
			"POST /tasks/:id/plan",
			"PUT  /tasks/:id/blueprint {slices, contracts, review?, rationale?}",
			"POST /tasks/:id/approve",
			"POST /tasks/:id/build",
			"GET  /tasks/:id/slices/:slice/builder",
			"POST /tasks/:id/slices/:slice/pushed",
			"POST /tasks/:id/slices/:slice/review",
			"POST /tasks/:id/slices/:slice/reviewers",
			"GET  /tasks/:id/slices/:slice/reviewers",
			"POST /tasks/:id/slices/:slice/reviews {reviewer, head, verdict, summary, evidence?}",
			"POST /tasks/:id/slices/:slice/message {message}",
			"POST /tasks/:id/slices/:slice/waive {reason}",
			"POST /tasks/:id/slices/:slice/gate",
			"POST /tasks/:id/slices/:slice/integrate",
			"POST /tasks/:id/land",
			"POST /repos/:repo/open {verify?, review?, limits?, leaseMinutes?}",
			"POST /tasks/:id/changes {title, intent, owns, hosted?}",
			"POST /tasks/:id/changes/:slice/extend {owns}",
			"POST /tasks/:id/changes/:slice/abandon {reason}",
			"GET  /tasks/:id/claims",
			"POST /mcp (MCP front door: JSON-RPC over HTTP)",
			"GET  /tasks/:id/ledger",
			"GET  /tasks/:id/lock-stats",
			"POST /tasks/:id/lock-stats/reset",
			"POST /tasks/:id/restore {repo}",
			"(contract amendments are proposed by builders; see task.amendments)",
		],
	}),
);

/**
 * Day 1 spike: proves the primitives the whole design rests on, with timings.
 * Creates a repo, pushes a commit, forks it twice, pushes a change to each fork
 * (one pair overlapping, one not), and test-merges them in memory.
 */
app.post("/spike", async (c) => {
	const artifacts = c.env.ARTIFACTS;
	const id = crypto.randomUUID().slice(0, 8);
	const timings: Record<string, number> = {};
	const time = async <T>(label: string, fn: () => Promise<T>) => {
		const start = Date.now();
		const result = await fn();
		timings[label] = Date.now() - start;
		return result;
	};

	const created = await time("create", () => retryTransient(() => artifacts.create(`spike-${id}`)));
	const origin = { url: created.remote, token: created.token };
	await time("initial push", async () => {
		const ws = await Workspace.init(origin);
		await ws.write({ "README.md": "# spike\n", "src/shared.ts": "export const greeting = 'hello';\n" });
		await ws.commit("Initial commit");
		await ws.push();
	});

	const [a, b] = await time("fork x2", () =>
		Promise.all([
			forkAndWait(artifacts, created.name, `spike-${id}-a`, "spike fork a"),
			forkAndWait(artifacts, created.name, `spike-${id}-b`, "spike fork b"),
		]),
	);
	await time("push to forks", async () => {
		for (const [fork, greeting] of [
			[a, "hi from a"],
			[b, "hi from b"],
		] as const) {
			const ws = await Workspace.clone({ url: fork.remote, token: fork.token });
			await ws.write({ "src/shared.ts": `export const greeting = '${greeting}';\n` });
			await ws.commit(`Change greeting in ${fork.name}`);
			await ws.push();
		}
	});

	const merge = await time("merge-ahead check", async () => {
		const ws = await Workspace.clone(await remoteFor(artifacts, created.name));
		await ws.fetch("a", await remoteFor(artifacts, a.name));
		await ws.fetch("b", await remoteFor(artifacts, b.name));
		return ws.tryMerge("refs/remotes/a/main", "refs/remotes/b/main");
	});

	return c.json({
		repos: [created.name, a.name, b.name],
		// Both forks edit the same line, so this should report a conflict in src/shared.ts.
		merge,
		timings,
		cleanup: "Spike repos are kept for inspection; delete them with `wrangler artifacts repos delete <name> --namespace blueprint`.",
	});
});

app.post("/repos/import", async (c) => {
	const { url, name, branch } = await c.req.json<{ url: string; name: string; branch?: string }>();
	const imported = await retryTransient(() => c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } }));
	return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
});

app.post("/tasks", async (c) => {
	const { repo, goal, limits } = await c.req.json<{ repo: string; goal: string; limits?: Partial<Limits> }>();
	const id = crypto.randomUUID().slice(0, 8);
	const task = await coordinator(c.env, id).create(id, repo, goal, limits);
	await taskIndex(c.env).add({ id, repo, goal, createdAt: task.createdAt });
	return c.json(task, 201);
});

// Open mode: one open task per repo, found by a stable id. Agents open changes on it and claim their lanes.
app.post("/repos/:repo/open", async (c) => {
	const repo = c.req.param("repo");
	const body = await c.req.json<{ verify?: string[]; review?: ReviewPolicy; limits?: Partial<Limits>; leaseMinutes?: number }>().catch(() => ({}));
	const id = await openTaskId(repo);
	const task = await coordinator(c.env, id).createOpen(id, repo, body);
	await taskIndex(c.env).add({ id, repo, goal: task.goal, createdAt: task.createdAt });
	return c.json(task, 201);
});

app.post("/tasks/:id/changes", async (c) => {
	const body = await c.req.json<{ title: string; intent: string; owns: string[]; hosted?: boolean }>();
	return c.json(await coordinator(c.env, c.req.param("id")).openChange(body, c.get("accessIdentity")), 201);
});

app.post("/tasks/:id/changes/:slice/extend", async (c) => {
	const { owns } = await c.req.json<{ owns: string[] }>();
	return c.json(await coordinator(c.env, c.req.param("id")).extendClaim(c.req.param("slice"), owns));
});

app.post("/tasks/:id/changes/:slice/abandon", async (c) => {
	const { reason } = await c.req.json<{ reason: string }>();
	return c.json(await coordinator(c.env, c.req.param("id")).abandonChange(c.req.param("slice"), reason, c.get("accessIdentity")));
});

app.get("/tasks/:id/claims", async (c) => c.json(await coordinator(c.env, c.req.param("id")).claims()));

// The MCP front door (stateless JSON-RPC over HTTP), for agents from anywhere.
app.post("/mcp", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
	const result = await handleMcpBody(body, { coordinator: (id) => coordinator(c.env, id) as unknown as ReturnType<McpContext["coordinator"]>, identity: c.get("accessIdentity") });
	return result === null ? c.body(null, 202) : c.json(result);
});
app.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

// Add a task created before the index existed.
app.post("/tasks/:id/index", async (c) => {
	const task = await coordinator(c.env, c.req.param("id")).state();
	await taskIndex(c.env).add({ id: task.id, repo: task.repo, goal: task.goal, createdAt: task.createdAt });
	return c.json({ indexed: task.id });
});

// Newest first, with each task's current state.
app.get("/tasks", async (c) => {
	const refs = await taskIndex(c.env).list(Number(c.req.query("limit") ?? 50));
	const tasks = await Promise.all(refs.map((r) => coordinator(c.env, r.id).state().catch(() => null)));
	return c.json(tasks.filter((t) => t !== null));
});

// Repos in the namespace, for the dashboard's "new task" form. Task repos
// (<taskId>--...) are left out.
app.get("/repos", async (c) => {
	const page = await retryTransient(() => c.env.ARTIFACTS.list({ limit: 100 }));
	return c.json(page.repos.filter((r) => !parseRepoName(r.name)).map((r) => ({ name: r.name })));
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
			const repo = `${id}--${s.id}`;
			const [builder, reviewers] = await Promise.all([
				c.env.BUILDER.getByName(repo).state(),
				s.reviewHead
					? Promise.all(
							task.review.reviewers.map(async (role) => ({
								role,
								state: await c.env.REVIEWER.getByName(reviewerName(repo, role, s.reviewHead!)).state(),
							})),
						)
					: [],
			]);
			return { id: s.id, builder, reviewers };
		}),
	);
	return c.json({ task, agents: slices });
});

app.get("/tasks/:id", async (c) => c.json(await coordinator(c.env, c.req.param("id")).state()));

// Read-only code views for the three human decision points.
app.get("/tasks/:id/contracts", async (c) => {
	const files = await coordinator(c.env, c.req.param("id")).contractFiles();
	return c.json({ files });
});

app.get("/tasks/:id/slices/:slice/diff", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).sliceDiff(slice));
});

app.get("/tasks/:id/land-diff", async (c) => c.json(await coordinator(c.env, c.req.param("id")).landingDiff()));

// Starts the planner agent; poll GET /tasks/:id until planner.status is done or failed.
app.post("/tasks/:id/plan", async (c) => c.json(await coordinator(c.env, c.req.param("id")).startPlanning(), 202));

app.put("/tasks/:id/blueprint", async (c) => {
	const blueprint = await c.req.json<Blueprint>();
	return c.json(await coordinator(c.env, c.req.param("id")).proposeBlueprint(blueprint));
});

// Returns write tokens for each slice's fork: hand them to the builder agents.
app.post("/tasks/:id/approve", async (c) => c.json(await humanCoordinator(c.env, c.req.param("id")).approve(c.get("accessIdentity"))));

// Starts a hosted builder agent (gpt-6-luna in its own container) for each slice.
app.post("/tasks/:id/build", async (c) => c.json(await coordinator(c.env, c.req.param("id")).startBuilders(), 202));

app.get("/tasks/:id/slices/:slice/builder", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await c.env.BUILDER.getByName(`${id}--${slice}`).state());
});

// Builder agents call this after each push. Runs Merge-ahead.
app.post("/tasks/:id/slices/:slice/pushed", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).recordPush(slice));
});

// Builder says the slice is ready. Returns read-only assignments for each reviewer agent.
app.post("/tasks/:id/slices/:slice/review", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).requestReview(slice));
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
	const states = await Promise.all(
		task.review.reviewers.map(async (role) => ({
			role,
			head,
			state: await c.env.REVIEWER.getByName(reviewerName(`${id}--${slice}`, role, head)).state(),
		})),
	);
	return c.json(states);
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

app.post("/tasks/:id/slices/:slice/integrate", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).integrate(slice));
});

app.post("/tasks/:id/land", async (c) => c.json(await humanCoordinator(c.env, c.req.param("id")).land(c.get("accessIdentity"))));

// The task's record in Git: rebuild it from the notes ref and compare with the stored state.
// Lock timings for benchmarks; POST clears them after reading.
app.get("/tasks/:id/lock-stats", async (c) => c.json(await coordinator(c.env, c.req.param("id")).lockStats()));
app.post("/tasks/:id/lock-stats/reset", async (c) => c.json(await coordinator(c.env, c.req.param("id")).lockStats(true)));

app.get("/tasks/:id/ledger", async (c) => c.json(await coordinator(c.env, c.req.param("id")).ledger()));

// Recreate a task whose Coordinator lost its state, from the record in the project repo.
app.post("/tasks/:id/restore", async (c) => {
	const { repo } = await c.req.json<{ repo: string }>();
	return c.json(await coordinator(c.env, c.req.param("id")).restore(c.req.param("id"), repo));
});

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
			if (event.type === "cf.artifacts.repo.pushed" && target && target.slice !== "base") {
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
