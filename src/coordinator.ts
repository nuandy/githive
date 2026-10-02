import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import { baseRepoName, forkAndWait, headOf, remoteFor, reviewerName, sliceRepoName } from "./artifacts";
import { fail, statusOf } from "./errors";
import { Workspace } from "./git";
import { blueprintProblems } from "./blueprint";
import { NEW_FILE, decideAmendment } from "./contract-owner";
import type { GateJob } from "./gate";
import { gateExclusions, gateFeedback, type GateResult } from "./gate-plan";
import type { BuildJob } from "./builder";
import type { ReviewJob } from "./reviewer";
import { plan } from "./planner";
import { nextStep, reviewFeedback, tally } from "./quorum";
import {
	DEFAULT_POLICY,
	type Amendment,
	type Blueprint,
	type MergeCheck,
	type Review,
	type ReviewAssignment,
	type Slice,
	type SliceCredentials,
	type Task,
} from "./types";

const conflictMessage = (files: string[]) =>
	`Review approved your slice, but it conflicts with work already integrated into the task base, in ${files.join(", ")}. Call fetch_base, merge it with \`git merge base/main\`, resolve the conflicts inside your lane, run your tests, then commit_and_push and finish.`;

/** Times a slice can go back to its builder before it waits for a human. */
const MAX_REVISIONS = 3;

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
				verify: [],
				review: DEFAULT_POLICY,
				slices: [],
				checks: [],
				amendments: [],
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
			const result = await plan(this.env, task.id, task.repo, task.goal);
			await this.proposeBlueprint(result.blueprint);
			outcome = { status: "done", usage: result.usage, toolCalls: result.toolCalls, contractCheck: result.contractCheck };
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
			task.slices = slices.map(({ id, title, owns, instructions, tests }) => ({
				id,
				title,
				owns,
				instructions,
				tests: tests ?? [],
				status: "planned",
				touched: [],
				outOfLane: [],
				reviews: [],
			}));
			task.contracts = Object.keys(contracts ?? {});
			task.verify = (blueprint.verify ?? []).filter((c) => c.trim());
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
					const [remote, base] = await Promise.all([
						remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600),
						remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3 * 3600),
					]);
					const job: BuildJob = {
						taskId: task.id,
						goal: task.goal,
						slice: { id: slice.id, title: slice.title, owns: slice.owns, instructions: slice.instructions, tests: slice.tests },
						siblings: task.slices.filter((s) => s !== slice).map(({ id, title, owns }) => ({ id, title, owns })),
						contracts: task.contracts,
						verify: task.verify,
						repo: slice.repo!,
						remote: remote.url,
						token: remote.token,
						base: { remote: base.url, token: base.token },
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
		const baseHead = await ws.head("main");

		// A slice's own changes start at its merge base with the task base. That is
		// the base commit until the slice merges integrated work; after that, the
		// integrated files don't count as the slice's changes.
		const side = async (s: Slice): Promise<Side & { from: string }> => {
			const ref = `refs/remotes/${s.id}/main`;
			const head = await ws.fetch(s.id, await remoteFor(artifacts, s.repo!));
			const from = await ws.mergeBase(baseHead, head);
			return { id: s.id, ref, head, from, touched: await ws.changedPaths(from, head) };
		};

		const ours = await side(slice);
		slice.head = ours.head;
		slice.mergeBase = ours.from;
		slice.touched = ours.touched;
		slice.outOfLane = ours.touched.filter((p) => !slice.owns.some((prefix) => p.startsWith(prefix)));

		const checks: MergeCheck[] = [];
		// Integrated slices move the base; check against it once it has.
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
			const head = await this.pinForReview(task, slice);
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

	/** Pin the slice's current head as the commit under review. */
	private async pinForReview(task: Task, slice: Slice) {
		if (slice.status !== "building") fail(409, `slice ${slice.id} is ${slice.status}`);
		const head = await headOf(this.env.ARTIFACTS, slice.repo!);
		if (!head || head === task.baseCommit) fail(409, `slice ${slice.id} has no work to review`);
		slice.reviewHead = head;
		return head;
	}

	/**
	 * Quorum, hosted. Pin the head and start one reviewer agent per role, each in
	 * its own container with a read-only token. Builders call this on finish.
	 */
	startReviewers(sliceId: string, buildSummary?: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			const head = await this.pinForReview(task, slice);
			if (buildSummary) slice.buildSummary = buildSummary;

			// Sent back, but finished without a new commit: the builder couldn't fix
			// it within its lane (for example, a finding that conflicts with a
			// contract). Another review of the same commit can't change anything.
			if (slice.sentBackFor && head === slice.sentBackFor) {
				slice.attention = `Sent back, but the builder finished without new commits; it needs a decision outside its lane. Builder's explanation: ${buildSummary ?? "none given"}`;
				await this.save(task);
				return { head, reviewers: [] as string[], failed: [] as string[], escalated: true };
			}
			await this.save(task);

			const reviewers = task.review.reviewers;
			const started = await Promise.allSettled(
				reviewers.map(async (role) => {
					const remote = await remoteFor(this.env.ARTIFACTS, slice.repo!, "read", 3 * 3600);
					const job: ReviewJob = {
						taskId: task.id,
						goal: task.goal,
						slice: { id: slice.id, title: slice.title, owns: slice.owns, instructions: slice.instructions, tests: slice.tests },
						siblings: task.slices.filter((s) => s !== slice).map(({ id, title, owns }) => ({ id, title, owns })),
						contracts: task.contracts,
						verify: task.verify,
						repo: slice.repo!,
						remote: remote.url,
						token: remote.token,
						role,
						head,
						baseCommit: slice.mergeBase ?? task.baseCommit!,
						buildSummary: slice.buildSummary,
						revision: slice.revisions ?? 0,
						priorFindings: slice.revisions ? slice.lastFeedback : undefined,
						amendments: (task.amendments ?? []).filter((a) => a.status === "approved").map(({ path, reason }) => ({ path, reason })),
					};
					await this.env.REVIEWER.getByName(reviewerName(slice.repo!, role, head)).start(job);
				}),
			);
			const failed = started.flatMap((r, i) => (r.status === "rejected" ? [`${reviewers[i]}: ${statusOf(r.reason).message}`] : []));
			if (failed.length) {
				const latest = await this.load();
				this.slice(latest, sliceId).attention = `Some reviewers did not start: ${failed.join("; ")}`;
				await this.save(latest);
			}
			const startedRoles = reviewers.filter((_, i) => started[i].status === "fulfilled");
			return { head, reviewers: startedRoles, failed, escalated: false };
		});
	}

	/**
	 * Contract amendments. A builder proposes a new version of a contract file;
	 * the contract owner agent decides; an approved change is committed to the
	 * task base and the builders of other running slices are told. The decision
	 * runs outside the lock, so pushes and votes aren't held up meanwhile.
	 */
	async proposeAmendment(sliceId: string, input: { path: string; content: string; reason: string }) {
		const { task, amendment } = await this.exclusive(async () => {
			const task = await this.load();
			this.slice(task, sliceId);
			if (task.phase !== "building") fail(409, `task is ${task.phase}`);
			if (!task.contracts.includes(input.path)) {
				// A new contract file (for example, a test a slice should be held to
				// that its lane can't contain). It must sit outside every lane and
				// must not be an existing project file.
				const path = input.path;
				if (path.startsWith("/") || path.split("/").includes("..")) fail(400, `invalid path: ${path}`);
				const owner = task.slices.find((s) => s.owns.some((prefix) => path.startsWith(prefix)));
				if (owner) fail(400, `${path} is inside ${owner.id}'s lane; a contract file must sit outside every lane`);
				if (await this.baseHas(task, path)) fail(400, `${path} is an existing project file, not a contract`);
			}
			const amendment: Amendment = {
				id: crypto.randomUUID().slice(0, 8),
				slice: sliceId,
				...input,
				status: "pending",
				at: new Date().toISOString(),
			};
			task.amendments = [...(task.amendments ?? []), amendment];
			await this.save(task);
			return { task, amendment };
		});

		let decision: { approve: boolean; reason: string };
		try {
			decision = await decideAmendment(this.env, {
				goal: task.goal,
				slices: task.slices.map(({ id, title, owns, tests }) => ({ id, title, owns, tests })),
				proposer: sliceId,
				path: input.path,
				reason: input.reason,
				current: await this.readBase(task, input.path),
				proposed: input.content,
			});
		} catch (err) {
			return this.settleAmendment(amendment.id, { status: "failed", decision: statusOf(err).message });
		}
		if (!decision.approve) return this.settleAmendment(amendment.id, { status: "rejected", decision: decision.reason });

		return this.exclusive(async () => {
			const latest = await this.load();
			const isNew = !latest.contracts.includes(input.path);
			const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, latest.baseRepo!, "write"));
			await ws.write({ [input.path]: input.content });
			const commit = await ws.commit(`Amend contract ${input.path} (proposed by ${sliceId})\n\n${input.reason}\n\nApproved: ${decision.reason}`);
			await ws.push();

			// Other slices' running builders need the new contract too.
			const message = `Contract ${input.path} was ${isNew ? "added" : "amended"} at the request of slice ${sliceId}: ${input.reason}\nThe contract owner approved it: ${decision.reason}\nCall fetch_base and merge base/main to get it, re-run your acceptance tests, then call commit_and_push.`;
			const others = latest.slices.filter((s) => s.id !== sliceId && s.status === "building");
			await Promise.allSettled(others.map((s) => this.env.BUILDER.getByName(s.repo!).notify(message)));

			if (isNew) {
				latest.contracts.push(input.path);
				// A new test becomes one of the proposing slice's acceptance tests.
				const proposer = this.slice(latest, sliceId);
				if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(input.path)) proposer.tests = [...(proposer.tests ?? []), input.path];
			}
			const a = latest.amendments!.find((x) => x.id === amendment.id)!;
			Object.assign(a, { status: "approved", decision: decision.reason, commit, decidedAt: new Date().toISOString() });
			await this.save(latest);
			return a;
		});
	}

	private settleAmendment(id: string, outcome: Pick<Amendment, "status" | "decision">) {
		return this.exclusive(async () => {
			const task = await this.load();
			const a = task.amendments!.find((x) => x.id === id)!;
			Object.assign(a, outcome, { decidedAt: new Date().toISOString() });
			await this.save(task);
			return a;
		});
	}

	private async baseHas(task: Task, path: string) {
		using repo = await this.env.ARTIFACTS.get(task.baseRepo!);
		return (await repo.readFile({ ref: "main", path })) !== null;
	}

	/** A file's current content on the task base. */
	private async readBase(task: Task, path: string) {
		using repo = await this.env.ARTIFACTS.get(task.baseRepo!);
		const blob = await repo.readFile({ ref: "main", path });
		return blob ? await blob.text() : NEW_FILE;
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
			const quorum = tally(task.review, slice);
			await this.save(task);

			// Auto-integrate an approved slice; send a rejected one back to its builder.
			const step = nextStep(task.review, slice);
			try {
				if (step === "integrate") {
					await this.integrateOrGate(task, slice);
				} else if (step === "send-back") {
					await this.sendBack(task, slice, reviewFeedback(task.review, slice));
				}
			} catch (err) {
				slice.attention = `${step} failed: ${statusOf(err).message}`;
			}
			await this.save(task);
			return { task, quorum, next: step };
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
			const result = await this.integrateSlice(task, slice);
			if (!result.ok) fail(409, `conflicts with base: ${result.files.join(", ")}`);
			await this.save(task);
			return task;
		});
	}

	/**
	 * An approved slice: integrate it directly when the task has no verify commands;
	 * otherwise run the integration gate first. Each commit is gated once, so a
	 * late approving vote doesn't start a second run.
	 */
	private async integrateOrGate(task: Task, slice: Slice) {
		if (!task.verify.length) {
			const result = await this.integrateSlice(task, slice);
			if (!result.ok) await this.sendBack(task, slice, conflictMessage(result.files));
			else await this.rerunWaitingGates(task);
			return;
		}
		if (slice.gate?.head === slice.reviewHead) return;
		await this.startGate(task, slice);
	}

	private async startGate(task: Task, slice: Slice) {
		const head = slice.reviewHead!;
		const baseHead = (await headOf(this.env.ARTIFACTS, task.baseRepo!))!;
		const exclude = gateExclusions(task.slices, slice.id);
		const [base, fork] = await Promise.all([
			remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3600),
			remoteFor(this.env.ARTIFACTS, slice.repo!, "read", 3600),
		]);
		slice.gate = { status: "running", head, baseHead, at: new Date().toISOString(), excluded: exclude };
		const job: GateJob = {
			taskId: task.id,
			slice: slice.id,
			head,
			baseHead,
			base: { remote: base.url, token: base.token },
			fork: { remote: fork.url, token: fork.token },
			checks: task.verify,
			exclude,
		};
		await this.env.GATE.getByName(`${slice.repo}--gate--${head.slice(0, 12)}--${baseHead.slice(0, 12)}`).start(job);
	}

	/**
	 * The gate reports back. A pass integrates the slice; a failure sends it
	 * back with the failing output. A result checked against a base that has
	 * since moved (another slice integrated) is discarded and the gate re-runs.
	 */
	gateResult(sliceId: string, result: GateResult, excluded: string[]) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building" || slice.gate?.head !== result.head || slice.reviewHead !== result.head)
				return { outcome: "stale" as const };
			const baseHead = await headOf(this.env.ARTIFACTS, task.baseRepo!);
			if (baseHead !== result.baseHead) {
				await this.startGate(task, slice);
				await this.save(task);
				return { outcome: "rerun" as const };
			}
			const at = new Date().toISOString();
			try {
				if (result.passed) {
					slice.gate = { ...slice.gate, status: "passed", result, at };
					const merged = await this.integrateSlice(task, slice);
					if (!merged.ok) await this.sendBack(task, slice, conflictMessage(merged.files));
					else await this.rerunWaitingGates(task);
				} else if (!result.mergeConflict && this.othersCanStillIntegrate(task, slice)) {
					// The failure may come from code in slices that aren't integrated yet
					// (a slice can depend on another's implementation of a contract).
					// Wait, and re-run after the next integration.
					slice.gate = { ...slice.gate, status: "waiting", result, at };
				} else {
					slice.gate = { ...slice.gate, status: "failed", result, at };
					await this.sendBack(task, slice, gateFeedback(result, excluded));
					// Nothing else can integrate, so slices waiting on each other go back too.
					for (const other of task.slices)
						if (other !== slice && other.gate?.status === "waiting" && !this.othersCanStillIntegrate(task, other)) {
							other.gate = { ...other.gate, status: "failed" };
							await this.sendBack(task, other, gateFeedback(other.gate.result!, other.gate.excluded));
						}
				}
			} catch (err) {
				slice.attention = `after the gate: ${statusOf(err).message}`;
			}
			await this.save(task);
			return { outcome: slice.gate?.status ?? "failed" };
		});
	}

	/**
	 * Run the gate again for an approved slice, for example after the task base
	 * was fixed by hand. Integrates on a pass, like any gate.
	 */
	retryGate(sliceId: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const quorum = tally(task.review, slice);
			const waived = slice.waivers?.some((w) => w.head === slice.reviewHead);
			if (quorum.status !== "approved" && !waived) fail(409, `quorum is ${quorum.status}`);
			if (!task.verify.length) fail(409, "the task has no verify commands");
			await this.startGate(task, slice);
			await this.save(task);
			return slice.gate;
		});
	}

	/**
	 * A human lets the slice's current review commit through without an
	 * approved quorum, for example when reviewers hold it to something its lane
	 * can't contain. Recorded on the slice; the integration gate still runs.
	 */
	waive(sliceId: string, input: { by: string; reason: string }) {
		return this.exclusive(async () => {
			if (!input.reason?.trim()) fail(400, "a waiver needs a reason");
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			if (!slice.reviewHead) fail(409, `slice ${sliceId} has no commit under review`);
			const builder = await this.env.BUILDER.getByName(slice.repo!).state();
			if (builder && (builder.status === "queued" || builder.status === "working")) fail(409, "the slice's builder is still working");
			const head = await headOf(this.env.ARTIFACTS, slice.repo!);
			if (head !== slice.reviewHead) fail(409, `the fork moved to ${head} after review of ${slice.reviewHead}`);

			slice.waivers = [...(slice.waivers ?? []), { head, by: input.by || "a human", reason: input.reason, at: new Date().toISOString() }];
			slice.attention = undefined;
			await this.integrateOrGate(task, slice);
			await this.save(task);
			return slice;
		});
	}

	/** Whether any other slice could still be integrated (and so might fix a failing gate). */
	private othersCanStillIntegrate(task: Task, slice: Slice) {
		return task.slices.some((s) => s !== slice && s.status === "building" && s.gate?.status !== "waiting");
	}

	/** After an integration, re-run gates that were waiting for it. */
	private async rerunWaitingGates(task: Task) {
		for (const s of task.slices) if (s.status === "building" && s.gate?.status === "waiting") await this.startGate(task, s);
	}

	/** Merge an approved slice into the task base. Caller holds the lock and saves. */
	private async integrateSlice(task: Task, slice: Slice): Promise<{ ok: true } | { ok: false; files: string[] }> {
		const head = await headOf(this.env.ARTIFACTS, slice.repo!);
		if (head !== slice.reviewHead) fail(409, `slice moved to ${head} after review of ${slice.reviewHead}`);
		if (slice.outOfLane.length) fail(409, `slice changed paths outside its lane: ${slice.outOfLane.join(", ")}`);

		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "write"));
		await ws.fetch(slice.id, await remoteFor(this.env.ARTIFACTS, slice.repo!));
		try {
			await ws.merge(`refs/remotes/${slice.id}/main`, `Integrate ${slice.id}: ${slice.title}`);
		} catch (err) {
			if (err instanceof git.Errors.MergeConflictError) return { ok: false, files: err.data.filepaths };
			throw err;
		}
		await ws.push();

		slice.status = "integrated";
		slice.attention = undefined;
		task.checks = task.checks.filter((c) => !c.pair.includes(slice.id));
		return { ok: true };
	}

	/**
	 * Feedback loop: hand the slice back to its builder with what to fix. Stops
	 * the reviewers of the current commit (their votes would be stale) and
	 * refreshes the builder's tokens. After MAX_REVISIONS, the slice waits for
	 * a human. Cancelling the reviewer whose vote triggered this is harmless: it
	 * marks itself done before it would check for cancellation.
	 */
	private async sendBack(task: Task, slice: Slice, message: string) {
		slice.sentBackFor = slice.reviewHead;
		slice.lastFeedback = message;
		if ((slice.revisions ?? 0) >= MAX_REVISIONS) {
			slice.attention = `Sent back ${MAX_REVISIONS} times without passing review; needs a human. Last feedback:\n${message}`;
			return;
		}
		slice.revisions = (slice.revisions ?? 0) + 1;
		const head = slice.reviewHead!;
		await Promise.allSettled(
			task.review.reviewers.map((role) =>
				this.env.REVIEWER.getByName(reviewerName(slice.repo!, role, head)).cancel("the slice was sent back to its builder"),
			),
		);
		const [write, base] = await Promise.all([
			remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600),
			remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3 * 3600),
		]);
		await this.env.BUILDER.getByName(slice.repo!).revise(message, { token: write.token, base: { remote: base.url, token: base.token } });
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
