import { Hono } from "hono";
import { forkAndWait, parseRepoName, remoteFor, reviewerName } from "./artifacts";
import { statusOf } from "./errors";
import { retryTransient } from "./retry";
import { Workspace } from "./git";
import type { Blueprint, Limits, Review } from "./types";

export { Builder } from "./builder";
export { Reviewer } from "./reviewer";
export { Coordinator } from "./coordinator";
export { ContractChecker } from "./contract-check";
export { Gate } from "./gate";
export { TaskIndex } from "./task-index";

const app = new Hono<{ Bindings: Env }>();

const coordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));
const taskIndex = (env: Env) => env.TASK_INDEX.getByName("all");

// Write routes mint Git tokens, so they require API_TOKEN when it is set.
app.use("*", async (c, next) => {
	if (c.req.method === "GET" || !c.env.API_TOKEN) return next();
	const encoder = new TextEncoder();
	const given = encoder.encode(c.req.header("Authorization") ?? "");
	const expected = encoder.encode(`Bearer ${c.env.API_TOKEN}`);
	const ok = given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
	return ok ? next() : c.json({ error: "unauthorized" }, 401);
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
			"POST /tasks/:id/slices/:slice/waive {reason, by?}",
			"POST /tasks/:id/slices/:slice/gate",
			"POST /tasks/:id/slices/:slice/integrate",
			"POST /tasks/:id/land",
			"GET  /tasks/:id/ledger",
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

// Starts the planner agent; poll GET /tasks/:id until planner.status is done or failed.
app.post("/tasks/:id/plan", async (c) => c.json(await coordinator(c.env, c.req.param("id")).startPlanning(), 202));

app.put("/tasks/:id/blueprint", async (c) => {
	const blueprint = await c.req.json<Blueprint>();
	return c.json(await coordinator(c.env, c.req.param("id")).proposeBlueprint(blueprint));
});

// Returns write tokens for each slice's fork: hand them to the builder agents.
app.post("/tasks/:id/approve", async (c) => c.json(await coordinator(c.env, c.req.param("id")).approve()));

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
	return c.json(await coordinator(c.env, id).messageBuilder(slice, message));
});

// A human lets the current review commit through without an approved quorum (recorded; the gate still runs).
app.post("/tasks/:id/slices/:slice/waive", async (c) => {
	const { id, slice } = c.req.param();
	const { reason, by } = await c.req.json<{ reason: string; by?: string }>();
	return c.json(await coordinator(c.env, id).waive(slice, { reason, by: by ?? "" }));
});

// Re-run the integration gate for an approved slice (for example after fixing the task base).
app.post("/tasks/:id/slices/:slice/gate", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).retryGate(slice), 202);
});

app.post("/tasks/:id/slices/:slice/integrate", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).integrate(slice));
});

app.post("/tasks/:id/land", async (c) => c.json(await coordinator(c.env, c.req.param("id")).land()));

// The task's record in Git: rebuild it from the notes ref and compare with the stored state.
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
