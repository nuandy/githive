import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import { baseRepoName, fileVersion, forkAndWait, headOf, remoteFor, reviewerName, sliceRepoName } from "./artifacts";
import { fail, statusOf } from "./errors";
import type { ContractCheckResult } from "./contract-check";
import { describeError } from "./contract-check-plan";
import { isTransientFailure, retryTransient } from "./retry";
import { Workspace } from "./git";
import { boundedUnifiedDiff } from "./code-view";
import { type LedgerDoc, type LedgerEntry, clipText, diff, fromDoc, replay, toDoc } from "./ledger";
import { appendLedger, readLedger } from "./ledger-git";
import { blueprintProblems } from "./blueprint";
import { NEW_FILE, decideAmendment } from "./contract-owner";
import type { GatePlan } from "./gate";
import { gateExclusions, gateFeedback, type GateResult } from "./gate-plan";
import type { BuildJob } from "./builder";
import type { ReviewJob } from "./reviewer";
import { plan } from "./planner";
import { nextStep, reviewFeedback, tally } from "./quorum";
import { activeOf, hasRoom, itemKey, stillWanted, validateLimits, withScheduling, type AgentKind } from "./schedule";
import { accessIdentityLabel, type AccessIdentity, type CoordinatorHumanActions } from "./access-contract";
import {
	DEFAULT_POLICY,
	type Amendment,
	type Blueprint,
	type Limits,
	type MergeCheck,
	type QueueItem,
	type Review,
	type ReviewAssignment,
	type Slice,
	type SliceCredentials,
	type Task,
} from "./types";

const staleMessage = (path: string, current: string | null) =>
	`${path} changed in the task base since the version you started from (it is now ${current ? current.slice(0, 12) : "deleted"}). Your proposal replaces the whole file, so committing it would undo that change. Revert any edits you made to ${path} yourself, call fetch_base, merge base/main, then propose again starting from the current version.`;

const conflictMessage = (files: string[]) =>
	`Review approved your slice, but it conflicts with work already integrated into the task base, in ${files.join(", ")}. Call fetch_base, merge it with \`git merge base/main\`, resolve the conflicts inside your lane, run your tests, then commit_and_push and finish.`;

/** Times a slice can go back to its builder before it waits for a human. */
const MAX_REVISIONS = 3;

/** Git's empty tree: where task-level decisions are noted when the project repo has no commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const short = (oid?: string) => oid?.slice(0, 8) ?? "none";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
export class Coordinator extends DurableObject<Env> implements CoordinatorHumanActions {
	// Methods await network I/O, which lets other requests interleave. Run
	// state-changing methods one at a time so they never overwrite each other.
	private tail: Promise<unknown> = Promise.resolve();

	/** Decisions made by the running method, written to Git when it finishes. */
	private entries: LedgerEntry[] = [];

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const recorded = async () => {
			try {
				return await fn();
			} catch (err) {
				// A method that failed didn't make its decisions; what it saved still goes out as state.
				this.entries = [];
				throw err;
			} finally {
				await this.flush();
			}
		};
		const run = this.tail.then(recorded, recorded);
		this.tail = run.catch(() => {});
		return run;
	}

	/** Note a decision on the commit it is about (the task's anchor commit for task-wide ones). */
	private note(task: Task, commit: string | undefined, text: string) {
		this.entries.push({ commit: commit ?? task.baseCommit ?? task.anchor ?? EMPTY_TREE, text, at: new Date().toISOString() });
	}

	/**
	 * Append the method's decisions and the state change since the last write to
	 * the task's notes ref. If Git can't be reached, both are kept and go out
	 * with the next write: the patch is always taken from the last recorded state.
	 */
	private async flush() {
		const entries = this.entries;
		this.entries = [];
		const task = await this.ctx.storage.get<Task>("task");
		if (!task) return;
		const [contracts, recorded, pending] = await Promise.all([
			this.ctx.storage.get<Record<string, string>>("contracts"),
			this.ctx.storage.get<LedgerDoc>("ledger:doc"),
			this.ctx.storage.get<LedgerEntry[]>("ledger:pending"),
		]);
		const doc = toDoc(task, contracts ?? {});
		const patch = diff(recorded ?? {}, doc);
		const all = [...(pending ?? []), ...entries];
		if (patch === undefined && !all.length) return;
		try {
			await appendLedger(await remoteFor(this.env.ARTIFACTS, task.repo, "write"), task.id, all, patch);
			await this.ctx.storage.put({ "ledger:doc": doc, "ledger:pending": [] });
		} catch (err) {
			await this.ctx.storage.put("ledger:pending", all);
			console.error(`ledger write for task ${task.id} failed: ${statusOf(err).message}`, err);
		}
	}

	/** Rebuild the task from its notes ref and compare it with the stored copy. */
	ledger() {
		return this.exclusive(async () => {
			const task = await this.load();
			const messages = await readLedger(await remoteFor(this.env.ARTIFACTS, task.repo), task.id);
			const contracts = (await this.ctx.storage.get<Record<string, string>>("contracts")) ?? {};
			const mismatch = diff(replay(messages), toDoc(task, contracts));
			// Typed loosely: the recursive JSON type is too deep for the RPC stub's types.
			return { commits: messages.length, matches: mismatch === undefined, mismatch: (mismatch ?? null) as Record<string, unknown> | null };
		});
	}

	/**
	 * Recreate a task from Git alone, into a Coordinator that has no state (for
	 * example after its storage was lost). Agents that were running are not
	 * restarted; slices that need them show as building with nothing active.
	 */
	restore(taskId: string, repo: string) {
		return this.exclusive(async () => {
			if (await this.ctx.storage.get("task")) fail(409, "task exists");
			const messages = await readLedger(await remoteFor(this.env.ARTIFACTS, repo), taskId);
			if (!messages.length) fail(404, `no record of task ${taskId} in ${repo}`);
			const doc = replay(messages);
			const { task, contracts } = fromDoc(doc);
			if (task.id !== taskId || task.repo !== repo) fail(409, `the record in ${repo} is for task ${task.id}`);
			await this.ctx.storage.put({ task, contracts, "ledger:doc": doc, "ledger:pending": [] });
			return { task, commits: messages.length };
		});
	}

	private async load() {
		return withScheduling((await this.ctx.storage.get<Task>("task")) ?? fail(404, "task not found"));
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

	/** Stored blueprint contracts are visible only while awaiting human approval. */
	async contractFiles() {
		const task = await this.load();
		if (task.phase !== "awaiting-approval") fail(409, `task is ${task.phase}`);
		const contracts = (await this.ctx.storage.get<Record<string, string>>("contracts")) ?? {};
		return Object.entries(contracts)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, content]) => ({ path, content }));
	}

	/** Diff the human-blocked slice's pinned review commit, never its moving head. */
	async sliceDiff(sliceId: string) {
		const task = await this.load();
		const slice = this.slice(task, sliceId);
		if (!slice.attention) fail(409, `slice ${sliceId} does not need a human`);
		if (!slice.reviewHead) fail(409, `slice ${sliceId} has no commit under review`);
		const base = slice.mergeBase ?? task.baseCommit;
		if (!base) fail(409, `slice ${sliceId} has no review base`);
		if (!slice.repo) fail(409, `slice ${sliceId} has no repository`);
		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, slice.repo, "read"));
		const files = await ws.changedFiles(base, slice.reviewHead);
		return { base, head: slice.reviewHead, ...boundedUnifiedDiff(files) };
	}

	/** Diff the complete integrated task base against the project's captured main head. */
	async landingDiff() {
		const task = await this.load();
		if (task.phase !== "building") fail(409, `task is ${task.phase}`);
		const pending = task.slices.filter((slice) => slice.status !== "integrated").map((slice) => slice.id);
		if (pending.length) fail(409, `slices not integrated: ${pending.join(", ")}`);
		if (!task.baseRepo) fail(409, "task has no base repository");
		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.repo, "read"));
		const projectHead = await ws.head();
		const head = await ws.fetch("task-base", await remoteFor(this.env.ARTIFACTS, task.baseRepo, "read"));
		const base = await ws.mergeBase(projectHead, head);
		const files = await ws.changedFiles(base, head);
		return { base, head, ...boundedUnifiedDiff(files) };
	}

	create(id: string, repo: string, goal: string, limits?: Partial<Limits>) {
		return this.exclusive(async () => {
			if (await this.ctx.storage.get("task")) fail(409, "task exists");
			try {
				using _repo = await retryTransient(() => this.env.ARTIFACTS.get(repo));
			} catch (err) {
				if (isTransientFailure(err)) throw err;
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
				limits: validateLimits(limits),
				queue: [],
				active: { builders: [], reviewers: [] },
				createdAt: new Date().toISOString(),
				anchor: (await headOf(this.env.ARTIFACTS, repo)) ?? EMPTY_TREE,
			};
			this.note(task, task.anchor, `Task ${id} created on ${repo}: ${goal}`);
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
			this.note(latest, undefined, outcome.status === "done" ? `Planner finished after ${outcome.toolCalls ?? 0} tool calls` : `Planner failed: ${outcome.error}`);
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
			this.note(
				task,
				undefined,
				`Blueprint proposed: ${plural(slices.length, "slice")} (${slices.map((s) => s.id).join(", ")}), ${plural(task.contracts.length, "contract file")}, quorum ${review.required} of ${review.reviewers.join("/")}` +
					(task.verify.length ? `, gate: ${task.verify.join(" && ")}` : "") +
					(rationale ? `\n${rationale}` : ""),
			);
			await this.ctx.storage.put("contracts", contracts ?? {});
			await this.save(task);
			return task;
		});
	}

	/**
	 * Fork the project into a task base, commit the contracts to it, then fork
	 * the base once per slice. Returns write credentials for each slice's builder.
	 */
	approve(actor: AccessIdentity) {
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
			this.note(task, task.baseCommit, `Blueprint approved by ${accessIdentityLabel(actor)}: contracts committed to ${baseRepo}; slices forked: ${task.slices.map((s) => s.repo).join(", ")}`);
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
			const started: { slice: string; status: string }[] = [];
			for (const slice of task.slices.filter((s) => s.status === "building"))
				started.push({ slice: slice.id, status: await this.schedule(task, { kind: "builder", slice: slice.id }) });
			await this.save(task);
			return { task, started };
		});
	}

	private async launchBuilder(task: Task, slice: Slice) {
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
		await this.env.BUILDER.getByName(slice.repo!).start(job);
	}

	private async launchReviewer(task: Task, slice: Slice, role: string, head: string) {
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
	}

	/**
	 * Start agent work if the task's limit allows, otherwise queue it. Work
	 * already running or queued is not started twice. Caller holds the lock and saves.
	 */
	private async schedule(task: Task, item: QueueItem): Promise<"started" | "queued" | "already"> {
		const key = itemKey(item);
		if (activeOf(task, item.kind).includes(key) || task.queue.some((q) => itemKey(q) === key)) return "already";
		if (!hasRoom(task, item.kind)) {
			task.queue.push(item);
			return "queued";
		}
		await this.launch(task, item);
		return "started";
	}

	private async launch(task: Task, item: QueueItem) {
		const key = itemKey(item);
		const slice = this.slice(task, item.slice);
		activeOf(task, item.kind).push(key);
		try {
			if (item.kind === "builder") await this.launchBuilder(task, slice);
			else await this.launchReviewer(task, slice, item.role, item.head);
		} catch (err) {
			const active = activeOf(task, item.kind);
			active.splice(active.indexOf(key), 1);
			slice.attention = `Could not start ${item.kind} ${key}: ${statusOf(err).message}`;
			this.note(task, slice.head, `${slice.id} needs a human: ${slice.attention}`);
		}
	}

	/** Start queued work while there is room, dropping work that is no longer wanted. */
	private async drain(task: Task) {
		if (task.queue.length && task.queue.some((item) => !hasRoom(task, item.kind))) await this.reconcile(task);
		for (const item of [...task.queue]) {
			const wanted = stillWanted(task, item);
			if (wanted && !hasRoom(task, item.kind)) continue;
			task.queue.splice(task.queue.indexOf(item), 1);
			if (wanted) await this.launch(task, item);
		}
	}

	/** Free slots held by agents that stopped without reporting it. */
	private async reconcile(task: Task) {
		const running = (s: { status: string } | null) => !!s && (s.status === "queued" || s.status === "working");
		for (const key of [...task.active.builders]) {
			const state = await this.env.BUILDER.getByName(sliceRepoName(task.id, key)).state();
			if (!running(state)) task.active.builders.splice(task.active.builders.indexOf(key), 1);
		}
		for (const key of [...task.active.reviewers]) {
			const [slice, role, head] = key.split(":");
			const state = await this.env.REVIEWER.getByName(reviewerName(sliceRepoName(task.id, slice), role, head)).state();
			if (!running(state)) task.active.reviewers.splice(task.active.reviewers.indexOf(key), 1);
		}
	}

	/** An agent stopped (finished, failed or was cancelled): free its slot and start queued work. */
	agentStopped(kind: AgentKind, key: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const active = activeOf(task, kind);
			if (active.includes(key)) active.splice(active.indexOf(key), 1);
			await this.drain(task);
			await this.save(task);
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
			const conflicts = checks.filter((c) => c.status === "conflict");
			this.note(
				task,
				slice.head,
				`${slice.id} pushed ${short(slice.head)}: ${plural(slice.touched.length, "file")} changed` +
					(slice.outOfLane.length ? `, outside its lane: ${slice.outOfLane.join(", ")}` : "") +
					`; Merge-ahead: ${conflicts.length ? conflicts.map((c) => `conflict ${c.pair.join("/")} in ${c.files.join(", ")}`).join("; ") : "no conflicts"}`,
			);
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
			this.note(task, head, `${slice.id} pinned for review at ${short(head)} by an external agent`);
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
				this.note(task, head, `${slice.id} needs a human: sent back, but its builder finished without new commits`);
				await this.save(task);
				return { head, reviewers: [] as string[], failed: [] as string[], escalated: true };
			}
			this.note(task, head, `${slice.id} ready for review at ${short(head)}${buildSummary ? `: ${buildSummary}` : ""}`);
			await this.save(task);

			const reviewers = task.review.reviewers;
			for (const role of reviewers) await this.schedule(task, { kind: "reviewer", slice: slice.id, role, head });
			await this.save(task);
			const failed = slice.attention?.startsWith("Could not start") ? [slice.attention] : [];
			const startedRoles = reviewers;
			return { head, reviewers: startedRoles, failed, escalated: false };
		});
	}

	/**
	 * Contract amendments. A builder proposes the whole new content of a contract
	 * file, a new contract file, or a project file outside every lane that slices
	 * share (which the change brings under contract). The contract owner agent
	 * decides; an approved change is committed to the task base and the builders
	 * of other running slices are told. The decision runs outside the lock, so
	 * pushes and votes aren't held up meanwhile.
	 *
	 * Proposals are whole files, so each names the version it was written
	 * against (`basedOn`). If the base has a different version, when proposed or
	 * when about to be committed, the proposal is refused as stale: committing it
	 * would undo changes made since, such as another slice's approved amendment.
	 */
	async proposeAmendment(sliceId: string, input: { path: string; content: string; reason: string; basedOn: string | null }) {
		const { task, amendment, current } = await this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (task.phase !== "building") fail(409, `task is ${task.phase}`);
			const path = input.path;
			if (input.basedOn === undefined) fail(400, "basedOn is required: the blob id of the version you started from, or null for a new file");
			if (!task.contracts.includes(path)) {
				// Anything that isn't a contract yet must sit outside every lane.
				if (path.startsWith("/") || path.split("/").includes("..")) fail(400, `invalid path: ${path}`);
				const owner = task.slices.find((s) => s.owns.some((prefix) => path.startsWith(prefix)));
				if (owner) fail(400, `${path} is inside ${owner.id}'s lane; a contract file must sit outside every lane`);
			}
			const current = await fileVersion(this.env.ARTIFACTS, task.baseRepo!, path);
			const kind: Amendment["kind"] = task.contracts.includes(path) ? "contract" : current ? "shared" : "new";
			const amendment: Amendment = {
				id: crypto.randomUUID().slice(0, 8),
				slice: sliceId,
				...input,
				kind,
				status: "pending",
				at: new Date().toISOString(),
			};
			task.amendments = [...(task.amendments ?? []), amendment];
			if ((current?.id ?? null) !== input.basedOn) {
				Object.assign(amendment, { status: "stale", decision: staleMessage(path, current?.id ?? null), decidedAt: amendment.at });
				this.note(task, slice.head, `${sliceId}'s change to ${path} refused: written against a version the base no longer has`);
			} else {
				this.note(task, slice.head, `${sliceId} proposed a change to ${kind === "shared" ? "shared file" : "contract"} ${path}: ${input.reason}`);
			}
			await this.save(task);
			return { task, amendment, current };
		});
		if (amendment.status === "stale") return amendment;

		let decision: { approve: boolean; reason: string };
		try {
			decision = await decideAmendment(this.env, {
				goal: task.goal,
				slices: task.slices.map(({ id, title, owns, tests }) => ({ id, title, owns, tests })),
				proposer: sliceId,
				path: input.path,
				kind: amendment.kind!,
				reason: input.reason,
				current: current?.text ?? NEW_FILE,
				proposed: input.content,
			});
		} catch (err) {
			return this.settleAmendment(amendment.id, { status: "failed", decision: statusOf(err).message });
		}
		if (!decision.approve) return this.settleAmendment(amendment.id, { status: "rejected", decision: decision.reason });

		// Contract checks can take tens of seconds. Run the first checks outside
		// the Coordinator lock; the checked commit is verified again under lock
		// before committing. After repeated base movement, check once under lock.
		const checker = this.env.CONTRACT_CHECKER.getByName("amend-" + task.id + "-" + amendment.id);
		const checkAt = async (commit: string): Promise<ContractCheckResult> => {
			try {
				const remote = await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read");
				return await checker.check({ remote: remote.url, token: remote.token, commit, contracts: { [input.path]: input.content } });
			} catch (err) {
				// Like the planner, don't block on checker infrastructure failures.
				return { status: "skipped", reason: "the check could not run: " + (err instanceof Error ? err.message : String(err)) };
			}
		};
		const failedCheckMessage = (result: Extract<ContractCheckResult, { status: "failed" }>) => {
			const diagnostics = result.errors.map(describeError);
			const details = diagnostics.length ? diagnostics.map((line) => "- " + line).join("\n") : "- The checker reported errors without diagnostics.";
			return "Contract check failed:\n" + details;
		};
		const staleFile = async (latest: Task, a: Amendment, now: { id: string; text: string } | null) => {
			Object.assign(a, { status: "stale", decision: staleMessage(input.path, now?.id ?? null), decidedAt: new Date().toISOString() });
			this.note(latest, this.slice(latest, sliceId).head, sliceId + "'s approved change to " + input.path + " not applied: the file changed while it was decided");
			await this.save(latest);
			return a;
		};
		const failedAmendment = async (latest: Task, a: Amendment, result: Extract<ContractCheckResult, { status: "failed" }>) => {
			Object.assign(a, { status: "failed", decision: failedCheckMessage(result), decidedAt: new Date().toISOString() });
			this.note(latest, this.slice(latest, sliceId).head, "Contract change to " + input.path + " for " + sliceId + " failed: " + a.decision);
			await this.save(latest);
			return a;
		};
		const applyApproved = async (latest: Task, a: Amendment) => {
			const brought = !latest.contracts.includes(input.path);
			const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, latest.baseRepo!, "write"));
			await ws.write({ [input.path]: input.content });
			const commit = await ws.commit("Amend contract " + input.path + " (proposed by " + sliceId + ")\n\n" + input.reason + "\n\nApproved: " + decision.reason);
			await ws.push();

			// Other slices' running builders need the new contract too.
			const what = a.kind === "new" ? "added as a contract" : a.kind === "shared" ? "changed and brought under contract" : "amended";
			const message = "Contract " + input.path + " was " + what + " at the request of slice " + sliceId + ": " + input.reason + "\nThe contract owner approved it: " + decision.reason + "\nCall fetch_base and merge base/main to get it, re-run your acceptance tests, then call commit_and_push.";
			const others = latest.slices.filter((s) => s.id !== sliceId && s.status === "building");
			await Promise.allSettled(others.map((s) => this.env.BUILDER.getByName(s.repo!).notify(message)));

			if (brought) {
				latest.contracts.push(input.path);
				// A new test becomes one of the proposing slice's acceptance tests.
				const proposer = this.slice(latest, sliceId);
				if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(input.path)) proposer.tests = [...(proposer.tests ?? []), input.path];
			}
			Object.assign(a, { status: "approved", decision: decision.reason, commit, decidedAt: new Date().toISOString() });
			this.note(latest, commit, "Contract " + input.path + " " + what + " for " + sliceId + "; the contract owner approved: " + decision.reason);
			await this.save(latest);
			return a;
		};

		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				let checkedCommit: string | null = null;
				let checkResult: ContractCheckResult;
				try {
					checkedCommit = await headOf(this.env.ARTIFACTS, task.baseRepo!);
					if (!checkedCommit) throw new Error("task base has no commits");
					checkResult = await checkAt(checkedCommit);
				} catch (err) {
					checkResult = { status: "skipped", reason: "the check could not run: " + (err instanceof Error ? err.message : String(err)) };
				}
				const outcome = await this.exclusive(async () => {
					const latest = await this.load();
					const a = latest.amendments!.find((x) => x.id === amendment.id)!;
					const now = await fileVersion(this.env.ARTIFACTS, latest.baseRepo!, input.path);
					if ((now?.id ?? null) !== input.basedOn)
						return { retry: false as const, value: await staleFile(latest, a, now) };

					// A different slice/amendment may have moved the base while the
					// checker ran. Don't apply an overlay checked against an old tree.
					const currentHead = await headOf(this.env.ARTIFACTS, latest.baseRepo!);
					if (currentHead !== checkedCommit) return { retry: true as const };
					if (checkResult.status === "failed") return { retry: false as const, value: await failedAmendment(latest, a, checkResult) };
					return { retry: false as const, value: await applyApproved(latest, a) };
				});
				if (!outcome.retry) return outcome.value;
			}

			// After three races, use the lock as a fallback so a stable task base
			// cannot keep an approved amendment from completing indefinitely.
			return await this.exclusive(async () => {
				const latest = await this.load();
				const a = latest.amendments!.find((x) => x.id === amendment.id)!;
				const now = await fileVersion(this.env.ARTIFACTS, latest.baseRepo!, input.path);
				if ((now?.id ?? null) !== input.basedOn) return staleFile(latest, a, now);

				const checkedCommit = await headOf(this.env.ARTIFACTS, latest.baseRepo!);
				let checkResult: ContractCheckResult;
				if (!checkedCommit) checkResult = { status: "skipped", reason: "task base has no commits" };
				else checkResult = await checkAt(checkedCommit);
				if (checkResult.status === "failed") return failedAmendment(latest, a, checkResult);

				// The lock prevents another Coordinator commit between the fallback
				// check and this commit. Refuse if the base nevertheless moved.
				const currentHead = await headOf(this.env.ARTIFACTS, latest.baseRepo!);
				if (currentHead !== checkedCommit) {
					Object.assign(a, { status: "stale", decision: "The task base moved while the contract check ran; re-propose against its current version.", decidedAt: new Date().toISOString() });
					this.note(latest, this.slice(latest, sliceId).head, "Contract change to " + input.path + " for " + sliceId + " not applied: the task base moved during its fallback check");
					await this.save(latest);
					return a;
				}
				return applyApproved(latest, a);
			});
		} finally {
			await checker.dispose().catch(() => {});
		}
	}

	private settleAmendment(id: string, outcome: Pick<Amendment, "status" | "decision">) {
		return this.exclusive(async () => {
			const task = await this.load();
			const a = task.amendments!.find((x) => x.id === id)!;
			Object.assign(a, outcome, { decidedAt: new Date().toISOString() });
			this.note(task, task.slices.find((s) => s.id === a.slice)?.head, `Contract change to ${a.path} for ${a.slice} ${a.status}: ${a.decision}`);
			await this.save(task);
			return a;
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
			const quorum = tally(task.review, slice);
			this.note(task, input.head, `${slice.id}: ${input.reviewer} reviewer ${input.verdict === "approve" ? "approved" : "rejected"}: ${input.summary}`);
			if (quorum.status !== "pending") this.note(task, input.head, `${slice.id}: quorum ${quorum.status}`);
			if (slice.status === "integrated" && input.verdict === "reject") {
				const finding = "Late rejection from " + input.reviewer + " after integration: " + input.summary + (input.evidence ? "\nEvidence: " + input.evidence : "");
				slice.attention = [slice.attention, finding].filter(Boolean).join("\n");
				this.note(task, input.head, slice.id + " needs a human: " + finding);
			}
			await this.save(task);
			// Keep valid late votes for the pinned head, but integration is final:
			// never send an already integrated slice back or integrate it again.
			if (slice.status === "integrated") return { task, quorum, next: "wait" as const };

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

	/** Queue the slice's approved commit with the task's gate. Caller holds the lock and saves. */
	private async startGate(task: Task, slice: Slice) {
		const head = slice.reviewHead!;
		slice.gate = { status: "queued", head, baseHead: "", at: new Date().toISOString(), excluded: [] };
		await this.env.GATE.getByName(task.id).enqueue(task.id, { slice: slice.id, head });
	}

	/**
	 * Slices that depend on each other (for example through a shared contract
	 * that imports both) can't pass the gate one at a time. Merge them together
	 * in one run instead. Caller holds the lock and saves.
	 */
	private async startGroupGate(task: Task, lead: Slice, members: Slice[]) {
		const ids = [lead.id, ...members.map((m) => m.id)];
		const at = new Date().toISOString();
		for (const s of [lead, ...members])
			s.gate = { status: "queued", head: s.reviewHead!, baseHead: "", at, excluded: [], group: ids.filter((id) => id !== s.id) };
		await this.env.GATE.getByName(task.id).enqueue(task.id, {
			slice: lead.id,
			head: lead.reviewHead!,
			group: members.map((m) => ({ slice: m.id, head: m.reviewHead! })),
		});
	}

	/** Slices of a gate run that are still the ones waiting to integrate at these commits. */
	private gateMembers(task: Task, sliceId: string, head: string, group: { slice: string; head: string }[] = []) {
		const members = [{ slice: sliceId, head }, ...group].map(({ slice: id, head: h }) => ({ s: task.slices.find((x) => x.id === id), h }));
		const valid = members.every(({ s, h }) =>
			s &&
			s.status === "building" &&
			s.reviewHead === h &&
			s.gate?.head === h &&
			(this.hasApprovedQuorum(task, s, h) || this.hasWaiver(s, h)),
		);
		return valid ? members.map(({ s }) => s!) : null;
	}

	/** A gate is authorized only by the current quorum or a human waiver for that exact head. */
	private hasApprovedQuorum(task: Task, slice: Slice, head: string) {
		return slice.reviewHead === head && tally(task.review, slice).status === "approved";
	}

	private hasWaiver(slice: Slice, head: string) {
		return slice.reviewHead === head && !!slice.waivers?.some((waiver) => waiver.head === head);
	}

	/**
	 * The gate asks for its plan when a run starts, so it checks against the base
	 * as it is then, with the exclusions and tokens of that moment. Null when the
	 * commits are no longer the ones waiting to integrate.
	 */
	gatePlan(sliceId: string, head: string, group: { slice: string; head: string }[] = []) {
		return this.exclusive(async (): Promise<GatePlan | null> => {
			const task = await this.load();
			const members = this.gateMembers(task, sliceId, head, group);
			if (!members) return null;
			const [lead, ...others] = members;
			const baseHead = (await headOf(this.env.ARTIFACTS, task.baseRepo!))!;
			const exclude = gateExclusions(task.slices, members.map((m) => m.id));
			const base = await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3600);
			const forks = await Promise.all(members.map((m) => remoteFor(this.env.ARTIFACTS, m.repo!, "read", 3600)));
			const at = new Date().toISOString();
			for (const m of members) m.gate = { ...m.gate!, status: "running", baseHead, at, excluded: exclude };
			await this.save(task);
			return {
				baseHead,
				base: { remote: base.url, token: base.token },
				fork: { remote: forks[0].url, token: forks[0].token },
				others: others.map((o, i) => ({ slice: o.id, head: o.reviewHead!, remote: forks[i + 1].url, token: forks[i + 1].token })),
				checks: task.verify,
				exclude,
			};
		});
	}

	/**
	 * The gate reports back. A pass integrates the slice (or every slice of a
	 * group, in order). A failure while other slices can still integrate waits
	 * for them; a failure with nothing left to wait for merges the slice with the
	 * slices waiting on it in one group run, or, failing that, sends it back with
	 * the failing output. A result checked against a base that has since moved
	 * is discarded and the gate re-runs.
	 */
	gateResult(sliceId: string, result: GateResult, excluded: string[], group: { slice: string; head: string }[] = []) {
		return this.exclusive(async () => {
			const task = await this.load();
			const members = this.gateMembers(task, sliceId, result.head, group);
			if (!members) return { outcome: "stale" as const };
			const [slice, ...others] = members;
			const baseHead = await headOf(this.env.ARTIFACTS, task.baseRepo!);
			if (baseHead !== result.baseHead) {
				this.note(task, slice.reviewHead, `${slice.id}: gate result discarded, the base moved from ${short(result.baseHead)} to ${short(baseHead)}; re-running`);
				if (others.length) await this.startGroupGate(task, slice, others);
				else await this.startGate(task, slice);
				await this.save(task);
				return { outcome: "rerun" as const };
			}
			const at = new Date().toISOString();
			const checked = members.map((m) => m.id).join(" + ");
			const outcome = result.mergeConflict
				? `merge conflict in ${result.mergeConflict.join(", ")}`
				: result.results.map((r) => `${r.command} → ${r.exitCode}`).join(", ");
			this.note(task, slice.reviewHead, `${checked}: gate ${result.passed ? "passed" : "failed"} on base ${short(result.baseHead)}: ${outcome}`);
			try {
				if (result.passed) {
					for (const m of members) m.gate = { ...m.gate!, status: "passed", baseHead: result.baseHead, result, at };
					// All or nothing: a group's slices only pass together, so the base never gets part of a group.
					const merged = await this.integrateSlices(task, members);
					if (merged.ok) await this.rerunWaitingGates(task);
					else {
						await this.sendBack(task, merged.slice, conflictMessage(merged.files));
						// The rest of the group waits for it, and is checked with it again once it's back.
						for (const m of members)
							if (m !== merged.slice) {
								m.gate = { ...m.gate!, status: "waiting" };
								this.note(task, m.reviewHead, `${m.id}: not integrated; ${merged.slice.id}, in the same group, conflicts with the base and went back to its builder`);
							}
					}
				} else if (others.length) {
					// A group run failed: every slice in it goes back, with the combined output.
					for (const m of members) {
						m.gate = { ...m.gate!, status: "failed", baseHead: result.baseHead, result, at };
						await this.sendBack(task, m, gateFeedback(result, excluded, members.filter((x) => x !== m).map((x) => x.id)));
					}
				} else if (!result.mergeConflict && this.othersCanStillIntegrate(task, slice)) {
					// The failure may come from code in slices that aren't integrated yet
					// (a slice can depend on another's implementation of a contract).
					// Wait, and re-run after the next integration.
					slice.gate = { ...slice.gate!, status: "waiting", baseHead: result.baseHead, result, at };
					this.note(task, slice.reviewHead, `${slice.id}: waiting for other slices to integrate before the gate re-runs`);
				} else {
					const waiting = task.slices.filter((s) => s !== slice && s.status === "building" && s.gate?.status === "waiting");
					if (!result.mergeConflict && waiting.length) {
						// Nothing else can integrate first, but slices are waiting on each
						// other: check them together.
						this.note(task, slice.reviewHead, `${slice.id}: gating together with ${waiting.map((w) => w.id).join(", ")}, which wait on each other`);
						await this.startGroupGate(task, slice, waiting);
					} else {
						slice.gate = { ...slice.gate!, status: "failed", baseHead: result.baseHead, result, at };
						await this.sendBack(task, slice, gateFeedback(result, excluded));
					}
				}
			} catch (err) {
				slice.attention = `after the gate: ${statusOf(err).message}`;
				this.note(task, slice.reviewHead, `${slice.id} needs a human: ${slice.attention}`);
			}
			await this.save(task);
			return { outcome: (slice.status === "integrated" ? "passed" : slice.gate?.status) ?? "failed" };
		});
	}

	/**
	 * Run the gate again for an approved slice, for example after the task base
	 * was fixed by hand. Integrates on a pass, like any gate.
	 */
	retryGate(sliceId: string, actor: AccessIdentity) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const quorum = tally(task.review, slice);
			const waived = slice.waivers?.some((w) => w.head === slice.reviewHead);
			if (quorum.status !== "approved" && !waived) fail(409, `quorum is ${quorum.status}`);
			if (!task.verify.length) fail(409, "the task has no verify commands");
			// A slice in a group gate retries with its group.
			const group = (slice.gate?.group ?? []).map((id) => task.slices.find((s) => s.id === id)).filter((s): s is Slice => !!s && s.status === "building");
			// Don't start a second run while one is queued or running: it would reset
			// the gate record under the first. Ask the Gate itself, so a record left
			// "queued" by a lost run can still be retried.
			const covered = new Set([slice.id, ...group.map((g) => g.id)]);
			const { queue, current } = await this.env.GATE.getByName(task.id).state();
			const busy = [current, ...queue].find((item) => item && [item.slice, ...(item.group ?? []).map((g) => g.slice)].some((id) => covered.has(id)));
			if (busy) fail(409, `a gate run for ${busy.slice} is already ${busy === current ? "running" : "queued"}`);
			this.note(task, slice.reviewHead, `${slice.id}: gate re-run requested by ${accessIdentityLabel(actor)}`);
			if (group.length) await this.startGroupGate(task, slice, group);
			else await this.startGate(task, slice);
			await this.save(task);
			return slice.gate;
		});
	}

	/**
	 * A human lets the slice's current review commit through without an
	 * approved quorum, for example when reviewers hold it to something its lane
	 * can't contain. Recorded on the slice; the integration gate still runs.
	 */
	waive(sliceId: string, input: { reason: string }, actor: AccessIdentity) {
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

			const by = accessIdentityLabel(actor);
			slice.waivers = [...(slice.waivers ?? []), { head, by, reason: input.reason, at: new Date().toISOString() }];
			slice.attention = undefined;
			this.note(task, head, `${slice.id}: quorum waived by ${by}: ${input.reason}`);
			await this.integrateOrGate(task, slice);
			await this.save(task);
			return slice;
		});
	}

	/** Flag a slice for a human (for example, its builder stopped). */
	flagSlice(sliceId: string, message: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status === "integrated") return;
			slice.attention = message;
			this.note(task, slice.head, `${slice.id} needs a human: ${message}`);
			await this.save(task);
		});
	}

	/**
	 * A human sends a message to a slice's builder. A running builder reads it
	 * at its next turn; a stopped one resumes its conversation with the
	 * message and fresh tokens. Clears the slice's flag.
	 */
	messageBuilder(sliceId: string, message: string, actor: AccessIdentity) {
		return this.exclusive(async () => {
			if (!message?.trim()) fail(400, "the message is empty");
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (slice.status !== "building") fail(409, `slice ${sliceId} is ${slice.status}`);
			const builder = this.env.BUILDER.getByName(slice.repo!);
			const text = `Message from a human on the team: ${message}`;
			let delivered: "inbox" | "resumed" = "inbox";
			if (!(await builder.notify(text))) {
				const [write, base] = await Promise.all([
					remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600),
					remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3 * 3600),
				]);
				await builder.revise(text, { token: write.token, base: { remote: base.url, token: base.token } });
				if (!task.active.builders.includes(slice.id)) task.active.builders.push(slice.id);
				delivered = "resumed";
			}
			slice.attention = undefined;
			this.note(task, slice.head, `Message from ${accessIdentityLabel(actor)} to ${slice.id}'s builder (${delivered === "inbox" ? "delivered" : "resumed it"}): ${message}`);
			await this.save(task);
			return { delivered };
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
		const merged = await this.integrateSlices(task, [slice]);
		return merged.ok ? merged : { ok: false, files: merged.files };
	}

	/**
	 * Merge approved slices into the task base atomically: every merge is made in
	 * one checkout and pushed once, so the base gets all of them or none. If any
	 * conflicts, nothing is pushed. Caller holds the lock and saves.
	 */
	private async integrateSlices(task: Task, slices: Slice[]): Promise<{ ok: true } | { ok: false; slice: Slice; files: string[] }> {
		for (const slice of slices) {
			const head = await headOf(this.env.ARTIFACTS, slice.repo!);
			if (head !== slice.reviewHead) fail(409, `${slice.id} moved to ${head} after review of ${slice.reviewHead}`);
			if (slice.outOfLane.length) fail(409, `${slice.id} changed paths outside its lane: ${slice.outOfLane.join(", ")}`);
		}
		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "write"));
		for (const slice of slices) {
			await ws.fetch(slice.id, await remoteFor(this.env.ARTIFACTS, slice.repo!));
			try {
				await ws.merge(`refs/remotes/${slice.id}/main`, `Integrate ${slice.id}: ${slice.title}`);
			} catch (err) {
				if (err instanceof git.Errors.MergeConflictError) return { ok: false, slice, files: err.data.filepaths };
				throw err;
			}
		}
		await ws.push();

		for (const slice of slices) {
			slice.status = "integrated";
			slice.attention = undefined;
			this.note(task, slice.reviewHead, `${slice.id} integrated into the task base${slices.length > 1 ? `, together with ${slices.filter((s) => s !== slice).map((s) => s.id).join(", ")}` : ""}`);
		}
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
		const head = slice.reviewHead!;
		// A queued or running gate may still be checking this commit (alone or as a
		// member of a group). Cancel it before handing control back to the builder.
		await this.env.GATE.getByName(task.id).cancel(task.id, slice.id, head);
		const groupIds = new Set([slice.id, ...(slice.gate?.head === head ? slice.gate.group ?? [] : [])]);
		for (const member of task.slices) {
			if (
				member.id !== slice.id &&
				(member.gate?.status === "queued" || member.gate?.status === "running") &&
				member.gate.head === member.reviewHead &&
				member.gate.group?.includes(slice.id)
			)
				groupIds.add(member.id);
		}
		for (const id of groupIds) {
			const member = task.slices.find((candidate) => candidate.id === id);
			if (!member?.gate) continue;
			const isSentBackHead = member === slice && member.gate.head === head;
			const isCancelledGroupMember =
				member.gate.head === member.reviewHead &&
				(member.gate.status === "queued" || member.gate.status === "running") &&
				member.gate.group?.includes(slice.id);
			if (isSentBackHead || isCancelledGroupMember) member.gate = undefined;
		}
		if ((slice.revisions ?? 0) >= MAX_REVISIONS) {
			slice.attention = `Sent back ${MAX_REVISIONS} times without passing review; needs a human. Last feedback:\n${message}`;
			this.note(task, slice.reviewHead, `${slice.id} needs a human: sent back ${MAX_REVISIONS} times without passing`);
			return;
		}
		slice.revisions = (slice.revisions ?? 0) + 1;
		this.note(task, slice.reviewHead, `${slice.id} sent back to its builder (revision ${slice.revisions} of ${MAX_REVISIONS}):\n${clipText(message, 1_500)}`);
		task.queue = task.queue.filter((item) => !(item.kind === "reviewer" && item.slice === slice.id));
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
		// A revision runs right away, outside the queue: the slice is blocking integration.
		if (!task.active.builders.includes(slice.id)) task.active.builders.push(slice.id);
	}

	/** Merge the task base into the project once every slice is integrated. */
	land(actor: AccessIdentity) {
		return this.exclusive(async () => {
			const task = await this.load();
			if (task.phase !== "building") fail(409, `task is ${task.phase}`);
			const pending = task.slices.filter((s) => s.status !== "integrated").map((s) => s.id);
			if (pending.length) fail(409, `slices not integrated: ${pending.join(", ")}`);

			const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.repo, "write"));
			await ws.fetch("base", await remoteFor(this.env.ARTIFACTS, task.baseRepo!));
			let landed: string | undefined;
			try {
				landed = (await ws.merge("refs/remotes/base/main", `Land task ${task.id}: ${task.goal}`))?.oid;
			} catch (err) {
				if (err instanceof git.Errors.MergeConflictError) fail(409, `conflicts with ${task.repo}: ${err.data.filepaths.join(", ")}`);
				throw err;
			}
			await ws.push();
			task.phase = "landed";
			this.note(task, landed, `Task landed in ${task.repo} by ${accessIdentityLabel(actor)}`);
			await this.save(task);
			return task;
		});
	}
}
