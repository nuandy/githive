import { Hono } from "hono";
import { forkAndWait, parseRepoName, remoteFor } from "./artifacts";
import { statusOf } from "./errors";
import { Workspace } from "./git";
import type { Blueprint, Review } from "./types";

export { Builder } from "./builder";
export { Coordinator } from "./coordinator";

const app = new Hono<{ Bindings: Env }>();

const coordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));

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
	return c.json({ error: message }, status as 400);
});

app.get("/", (c) =>
	c.json({
		name: "blueprint",
		routes: [
			"POST /spike",
			"POST /repos/import {url, name, branch?}",
			"POST /tasks {repo, goal}",
			"GET  /tasks/:id",
			"POST /tasks/:id/plan",
			"PUT  /tasks/:id/blueprint {slices, contracts, review?, rationale?}",
			"POST /tasks/:id/approve",
			"POST /tasks/:id/build",
			"GET  /tasks/:id/slices/:slice/builder",
			"POST /tasks/:id/slices/:slice/pushed",
			"POST /tasks/:id/slices/:slice/review",
			"POST /tasks/:id/slices/:slice/reviews {reviewer, head, verdict, summary, evidence?}",
			"POST /tasks/:id/slices/:slice/integrate",
			"POST /tasks/:id/land",
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

	const created = await time("create", () => artifacts.create(`spike-${id}`));
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
	const imported = await c.env.ARTIFACTS.import({ source: { url, branch }, target: { name } });
	return c.json({ name: imported.name, remote: imported.remote, defaultBranch: imported.defaultBranch });
});

app.post("/tasks", async (c) => {
	const { repo, goal } = await c.req.json<{ repo: string; goal: string }>();
	const id = crypto.randomUUID().slice(0, 8);
	return c.json(await coordinator(c.env, id).create(id, repo, goal), 201);
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

app.post("/tasks/:id/slices/:slice/reviews", async (c) => {
	const { id, slice } = c.req.param();
	const review = await c.req.json<Omit<Review, "at">>();
	return c.json(await coordinator(c.env, id).submitReview(slice, review));
});

app.post("/tasks/:id/slices/:slice/integrate", async (c) => {
	const { id, slice } = c.req.param();
	return c.json(await coordinator(c.env, id).integrate(slice));
});

app.post("/tasks/:id/land", async (c) => c.json(await coordinator(c.env, c.req.param("id")).land()));

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
					console.error("recordPush failed", event.source.repoName, statusOf(err).message);
				}
			}
			message.ack();
		}
	},
} satisfies ExportedHandler<Env, ArtifactsEvent>;
