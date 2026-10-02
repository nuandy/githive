import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import { baseRepoName, forkAndWait, headOf, remoteFor, sliceRepoName } from "./artifacts";
import { fail } from "./errors";
import { Workspace } from "./git";
import { blueprintProblems } from "./blueprint";
import type { BuildJob } from "./builder";
import { plan } from "./planner";
import { tally } from "./quorum";
import {
	DEFAULT_POLICY,
	type Blueprint,
	type MergeCheck,
	type Review,
	type ReviewAssignment,
	type Slice,
	type SliceCredentials,
	type Task,
} from "./types";

/** One side of a Merge-ahead check. */
interface Side {
	id: string;
	ref: string;
	head: string;
	touched: string[];
}

/**
 * One Coordinator per task. It owns the task's state and runs every Git operation
 * on the task's repos: forking slices, test-merging them against each other
 * (Merge-ahead), gating integration on reviewer votes (Quorum), and landing.
 */
export class Coordinator extends DurableObject<Env> {
	// Methods await network I/O, which lets other requests interleave. Run
	// state-changing methods one at a time so they never overwrite each other.
	private tail: Promise<unknown> = Promise.resolve();

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		this.tail = run.catch(() => {});
		return run;
	}

	private async load() {
		return (await this.ctx.storage.get<Task>("task")) ?? fail(404, "task not found");
	}

	private save(task: Task) {
		return this.ctx.storage.put("task", task);
	}

	private slice(task: Task, id: string) {
		return task.slices.find((s) => s.id === id) ?? fail(404, `no slice ${id}`);
	}

	state() {
		return this.load();
	}

	create(id: string, repo: string, goal: string) {
		return this.exclusive(async () => {
			if (await this.ctx.storage.get("task")) fail(409, "task exists");
			try {
				using _repo = await this.env.ARTIFACTS.get(repo);
			} catch {
				fail(404, `no repo ${repo}`);
			}
			const task: Task = {
				id,
				repo,
				goal,
				phase: "planning",
				contracts: [],
				review: DEFAULT_POLICY,
				slices: [],
				checks: [],
				createdAt: new Date().toISOString(),
			};
			await this.save(task);
			return task;
		});
	}

	/** Start the planner agent. It runs from an alarm because a run takes minutes. */
	startPlanning() {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "planning" && task.phase !== "awaiting-approval") fail(409, `task is ${task.phase}`);
			if (task.planner?.status === "running") fail(409, "the planner is already running");
			if (!this.env.OPENAI_API_KEY) fail(500, "OPENAI_API_KEY is not set");
			task.planner = { status: "running", startedAt: new Date().toISOString() };
			await this.save(task);
			await this.ctx.storage.setAlarm(Date.now());
			return task;
		});
	}

	async alarm() {
		const task = await this.load();
		if (task.planner?.status !== "running") return;
		let outcome: Partial<NonNullable<Task["planner"]>>;
		try {
			const result = await plan(this.env, task.repo, task.goal);
			await this.proposeBlueprint(result.blueprint);
			outcome = { status: "done", usage: result.usage, toolCalls: result.toolCalls };
		} catch (err) {
			outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
		}
		await this.exclusive(async () => {
			const latest = await this.load();
			latest.planner = { ...latest.planner!, ...outcome, finishedAt: new Date().toISOString() };
			await this.save(latest);
		});
	}

	/** Store a proposed blueprint. A human (or the planner agent) approves it next. */
	proposeBlueprint(blueprint: Blueprint) {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "planning" && task.phase !== "awaiting-approval") fail(409, `task is ${task.phase}`);

			const problems = blueprintProblems(blueprint);
			if (problems.length) fail(400, problems.join(" "));
			const { slices, contracts, rationale } = blueprint;
			const review = blueprint.review ?? DEFAULT_POLICY;

			task.rationale = rationale;
			task.slices = slices.map(({ id, title, owns, instructions }) => ({
				id,
				title,
				owns,
				instructions,
				status: "planned",
				touched: [],
				outOfLane: [],
				reviews: [],
			}));
			task.contracts = Object.keys(contracts ?? {});
			task.review = review;
			task.phase = "awaiting-approval";
			await this.ctx.storage.put("contracts", contracts ?? {});
			await this.save(task);
			return task;
		});
	}

	/**
	 * Fork the project into a task base, commit the contracts to it, then fork
	 * the base once per slice. Returns write credentials for each slice's builder.
	 */
	approve() {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "awaiting-approval") fail(409, `task is ${task.phase}`);
			const artifacts = this.env.ARTIFACTS;

			const baseRepo = baseRepoName(task.id);
			const base = await forkAndWait(artifacts, task.repo, baseRepo, `Base for task: ${task.goal}`);
			const contracts = (await this.ctx.storage.get<Record<string, string>>("contracts")) ?? {};
			if (Object.keys(contracts).length) {
				const ws = await Workspace.clone({ url: base.remote, token: base.token });
				await ws.write(contracts);
				await ws.commit(`Blueprint contracts: ${task.goal}`);
				await ws.push();
			}
			task.baseRepo = baseRepo;
			task.baseCommit = (await headOf(artifacts, baseRepo)) ?? fail(500, "base has no commits");

			const credentials: SliceCredentials[] = await Promise.all(
				task.slices.map(async (slice) => {
					const repo = sliceRepoName(task.id, slice.id);
					const fork = await forkAndWait(artifacts, baseRepo, repo, `${slice.title} (task ${task.id})`);
					slice.repo = repo;
					slice.head = task.baseCommit;
					slice.status = "building";
					return { slice: slice.id, repo, remote: fork.remote, token: fork.token };
				}),
			);
			task.phase = "building";
			await this.save(task);
			return { task, credentials };
		});
	}

	/**
	 * Start a hosted builder agent for every slice that is building. Each gets a
	 * write token for its own fork only. External agents can use the credentials
	 * from approve() instead.
	 */
	startBuilders() {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "building") fail(409, `task is ${task.phase}`);
			const building = task.slices.filter((s) => s.status === "building");
			const started = await Promise.all(
				building.map(async (slice) => {
					const remote = await remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600);
					const job: BuildJob = {
						taskId: task.id,
						goal: task.goal,
						slice: { id: slice.id, title: slice.title, owns: slice.owns, instructions: slice.instructions },
						siblings: task.slices.filter((s) => s !== slice).map(({ id, title, owns }) => ({ id, title, owns })),
						contracts: task.contracts,
						repo: slice.repo!,
						remote: remote.url,
						token: remote.token,
					};
					return { slice: slice.id, builder: await this.env.BUILDER.getByName(slice.repo!).start(job) };
				}),
			);
			return { task, started };
		});
	}

	/**
	 * Merge-ahead. Called whenever a slice's fork may have moved. Records what the
	 * slice touched, flags paths outside its lane, and test-merges it against the
	 * base and every other slice that has pushed work.
	 */
	recordPush(sliceId: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const head = await headOf(this.env.ARTIFACTS, slice.repo!);
			if (!head || head === slice.head) return { task, checks: [] as MergeCheck[], changed: false };

			const checks = await this.mergeAhead(task, slice);
			const keys = new Set(checks.map((c) => c.pair.join("|")));
			task.checks = task.checks.filter((c) => !keys.has(c.pair.join("|"))).concat(checks);
			await this.save(task);
			return { task, checks, changed: true };
		});
	}

	private async mergeAhead(task: Task, slice: Slice) {
		const artifacts = this.env.ARTIFACTS;
		const baseCommit = task.baseCommit!;
		const ws = await Workspace.clone(await remoteFor(artifacts, task.baseRepo!));

		const side = async (s: Slice): Promise<Side> => {
			const ref = `refs/remotes/${s.id}/main`;
			const head = await ws.fetch(s.id, await remoteFor(artifacts, s.repo!));
			return { id: s.id, ref, head, touched: await ws.changedPaths(baseCommit, head) };
		};

		const ours = await side(slice);
		slice.head = ours.head;
		slice.touched = ours.touched;
		slice.outOfLane = ours.touched.filter((p) => !slice.owns.some((prefix) => p.startsWith(prefix)));

		const checks: MergeCheck[] = [];
		// Integrated slices move the base; check against it once it has.
		const baseHead = await ws.head("main");
		if (baseHead !== baseCommit) {
			const base = { id: "base", ref: "main", head: baseHead, touched: await ws.changedPaths(baseCommit, baseHead) };
			checks.push(await this.check(ws, base, ours));
		}
		for (const other of task.slices) {
			if (other === slice || other.status !== "building") continue;
			const theirs = await side(other);
			if (theirs.head === baseCommit) continue; // nothing pushed yet
			checks.push(await this.check(ws, theirs, ours));
		}
		// TODO(semantic): run the test suite on each clean merge in a Sandbox to
		// catch changes that merge cleanly but fail together.
		return checks;
	}

	private async check(ws: Workspace, a: Side, b: Side): Promise<MergeCheck> {
		const [first, second] = a.id < b.id ? [a, b] : [b, a];
		const shared = first.touched.filter((p) => second.touched.includes(p));
		// Git only conflicts on files both sides changed.
		const outcome = shared.length ? await ws.tryMerge(first.ref, second.ref) : null;
		return {
			pair: [first.id, second.id],
			heads: [first.head, second.head],
			status: !outcome ? "disjoint" : outcome.clean ? "clean" : "conflict",
			files: outcome && !outcome.clean ? outcome.files : [],
			checkedAt: new Date().toISOString(),
		};
	}

	/**
	 * Quorum, step 1. The builder says the slice is ready. Pin the current head
	 * and hand each reviewer a read-only token for it.
	 */
	requestReview(sliceId: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const head = await headOf(this.env.ARTIFACTS, slice.repo!);
			if (!head || head === task.baseCommit) fail(409, `slice ${sliceId} has no work to review`);

			slice.reviewHead = head;
			const assignments: ReviewAssignment[] = await Promise.all(
				task.review.reviewers.map(async (reviewer) => {
					const remote = await remoteFor(this.env.ARTIFACTS, slice.repo!, "read", 3600);
					return { reviewer, head, slice: slice.id, repo: slice.repo!, remote: remote.url, token: remote.token };
				}),
			);
			await this.save(task);
			return { task, assignments };
		});
	}

	/** Quorum, step 2. A reviewer agent submits its verdict on the pinned head. */
	submitReview(sliceId: string, input: Omit<Review, "at">) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (!task.review.reviewers.includes(input.reviewer)) fail(400, `unknown reviewer ${input.reviewer}`);
			if (input.verdict !== "approve" && input.verdict !== "reject") fail(400, "verdict must be approve or reject");
			if (!slice.reviewHead || input.head !== slice.reviewHead)
				fail(409, `review is for ${input.head}, but the head under review is ${slice.reviewHead ?? "none"}`);

			slice.reviews.push({ ...input, at: new Date().toISOString() });
			await this.save(task);
			return { task, quorum: tally(task.review, slice) };
		});
	}

	/** Merge a slice into the task base. Requires an approved quorum on the slice's current head. */
	integrate(sliceId: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const quorum = tally(task.review, slice);
			if (quorum.status !== "approved") fail(409, `quorum is ${quorum.status}: ${JSON.stringify(quorum)}`);
			const head = await headOf(this.env.ARTIFACTS, slice.repo!);
			if (head !== slice.reviewHead) fail(409, `slice moved to ${head} after review of ${slice.reviewHead}`);
			if (slice.outOfLane.length) fail(409, `slice changed paths outside its lane: ${slice.outOfLane.join(", ")}`);

			const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "write"));
			await ws.fetch(slice.id, await remoteFor(this.env.ARTIFACTS, slice.repo!));
			try {
				await ws.merge(`refs/remotes/${slice.id}/main`, `Integrate ${slice.id}: ${slice.title}`);
			} catch (err) {
				if (err instanceof git.Errors.MergeConflictError) fail(409, `conflicts with base: ${err.data.filepaths.join(", ")}`);
				throw err;
			}
			await ws.push();

			slice.status = "integrated";
			task.checks = task.checks.filter((c) => !c.pair.includes(slice.id));
			await this.save(task);
			return task;
		});
	}

	/** Merge the task base into the project once every slice is integrated. */
	land() {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "building") fail(409, `task is ${task.phase}`);
			const pending = task.slices.filter((s) => s.status !== "integrated").map((s) => s.id);
			if (pending.length) fail(409, `slices not integrated: ${pending.join(", ")}`);

			const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.repo, "write"));
			await ws.fetch("base", await remoteFor(this.env.ARTIFACTS, task.baseRepo!));
			try {
				await ws.merge("refs/remotes/base/main", `Land task ${task.id}: ${task.goal}`);
			} catch (err) {
				if (err instanceof git.Errors.MergeConflictError) fail(409, `conflicts with ${task.repo}: ${err.data.filepaths.join(", ")}`);
				throw err;
			}
			await ws.push();
			task.phase = "landed";
			await this.save(task);
			return task;
		});
	}
}
