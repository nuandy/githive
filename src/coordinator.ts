import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import { forkAndWait, headOf, remoteFor, reviewerName, sliceRepoName } from "./artifacts";
import { fail, statusOf } from "./errors";
import type { LaneChangeAnswer, LaneChangeCoordinator, LaneChangeRequest, LaneChangeRequestInput } from "./lane-change-contract";
import { BUILDER_PARK_TIMEOUT_MS, type BuilderResumeCredentials, type ParkBuilderResult } from "./parking-contract";
import { isTransientFailure, retryTransient } from "./retry";
import { branchHead, Workspace } from "./git";
import { projectBranch } from "./project-branch";
import { boundedUnifiedDiff } from "./code-view";
import { type LedgerEntry, clipText, diff, fromDoc, replay, toDoc } from "./ledger";
import { readLedger } from "./ledger-git";
import { LedgerOutbox, LockStats } from "./ledger-outbox";
import { closesLaneRequestCycle, latestResolutions, laneRequestMessage, safeLanePath, unresolvedRequests } from "./lane-requests";
import { mergeAhead } from "./merge-ahead";
import type { GatePlan } from "./gate";
import { gateExclusions, gateFeedback, gateMembers, othersCanStillIntegrate, type GateResult } from "./gate-plan";
import type { BuildJob } from "./builder";
import type { Remote } from "./git";
import type { ReviewJob } from "./reviewer";
import type { SliceJob } from "./sandbox";
import { OPENING_LEASE_MS, awaitedExternalRoles, claimConflicts, externalReviewCheck, gateStallCheck, claimsOf, conflictMessage as claimConflictMessage, agentName, changeId, holdsClaim, inLane, leaseExpired, leaseUntil, nextLeaseCheck, normalizeClaim } from "./open-mode";
import { effectivePolicy, nextStep, reviewFeedback, tally, validatePolicy } from "./quorum";
import { activeOf, hasRoom, itemKey, stillWanted, validateLimits, withScheduling, type AgentKind } from "./schedule";
import { accessIdentityLabel, type AccessIdentity, type CoordinatorHumanActions } from "./access-contract";
import { identityLabel } from "./free/stamp";
import {
	DEFAULT_POLICY,
	type Limits,
	type MergeCheck,
	type QueueItem,
	type Review,
	type ReviewAssignment,
	type ReviewPolicy,
	type Slice,
	type SliceCredentials,
	type Task,
} from "./types";

const conflictMessage = (files: string[]) =>
	`Review approved your slice, but it conflicts with work already integrated into the task base, in ${files.join(", ")}. Call fetch_base, merge what it fetched, resolve the conflicts inside your lane, run your tests, then commit_and_push and finish.`;

/** What a change's review covers: the paths it claimed and the files it touched. */
const changePaths = (slice: Slice) => [...new Set([...(slice.owns ?? []), ...(slice.touched ?? [])])];

/** The review policy for a change: the one set when its commit went to review, or what it would be now. */
export const policyFor = (task: Task, slice: Slice) => slice.review ?? effectivePolicy(task.review, changePaths(slice));

/** The roles Blueprint's own reviewer agents review: all but the external ones. */
export const hostedRoles = (policy: ReviewPolicy) => policy.reviewers.filter((r) => !(policy.external ?? []).includes(r));

/** Times a slice can go back to its builder before it waits for a human. */
const MAX_REVISIONS = 3;

/** Git's empty tree: where task-level decisions are noted when the project repo has no commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const short = (oid?: string) => oid?.slice(0, 8) ?? "none";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Remove `key` from a list in place (such as a task's active agents), if it is there. */
function removeKey(list: string[], key: string) {
	const index = list.indexOf(key);
	if (index >= 0) list.splice(index, 1);
}

/**
 * A new task, with nothing planned, queued or running yet. `head` holds the
 * fields that come first in the stored task (an open task's mode and base among
 * them), so both kinds keep their field order.
 */
function newTask(head: Pick<Task, "id" | "repo" | "goal" | "phase"> & Partial<Task>, rest: { verify?: string[]; review?: ReviewPolicy; limits: Limits; anchor: string }): Task {
	return {
		...head,
		verify: rest.verify ?? [],
		review: rest.review ?? DEFAULT_POLICY,
		slices: [],
		checks: [],
		limits: rest.limits,
		queue: [],
		active: { builders: [], reviewers: [] },
		createdAt: new Date().toISOString(),
		anchor: rest.anchor,
	};
}

/** The options an open task can be started with. */
export interface OpenTaskInput {
	verify?: string[];
	review?: ReviewPolicy;
	limits?: Partial<Limits>;
	leaseMinutes?: number;
}

/** A new open task on `repo`, based at `head`. Throws `[400]` for invalid options. */
export function openTaskFor(id: string, repo: string, head: string, input: OpenTaskInput = {}, branch = "main"): Task {
	const review = input.review ?? DEFAULT_POLICY;
	validatePolicy(review);
	const leaseMinutes = input.leaseMinutes ?? 30;
	if (!Number.isInteger(leaseMinutes) || leaseMinutes < 5 || leaseMinutes > 1440) fail(400, "leaseMinutes must be a whole number from 5 to 1440");
	return newTask(
		{ id, repo, goal: `Open changes on ${repo}`, phase: "building", mode: "open", leaseMinutes, baseRepo: repo, baseCommit: head, branch },
		{ verify: (input.verify ?? []).filter((c) => typeof c === "string" && c.trim()), review, limits: validateLimits(input.limits), anchor: head },
	);
}

/** What every agent working on a slice is told about it: the fields BuildJob and ReviewJob share, less credentials. */
function sliceJobBase(task: Task, slice: Slice): Omit<SliceJob, "remote" | "token"> {
	return {
		taskId: task.id,
		goal: task.goal,
		branch: projectBranch(task),
		slice: { id: slice.id, title: slice.title, owns: slice.owns, instructions: slice.instructions, tests: slice.tests },
		siblings: task.slices.filter((s) => s !== slice && s.status !== "abandoned").map(({ id, title, owns }) => ({ id, title, owns })),
		verify: task.verify,
		repo: agentsOf(task, slice),
		...(slice.ref ? { ref: slice.ref } : {}),
	};
}

/** A change's own agents (its builder, its reviewers) are named after it: <task>--<change>. */
export const agentsOf = (task: Pick<Task, "id">, slice: Pick<Slice, "id">) => sliceRepoName(task.id, slice.id);

/** The branch a change's commits are on in its fork: changes/<id>, or (changes made when each had its own fork) the project's branch. */
export const changeRef = (task: Task, slice: Slice) => slice.ref ?? projectBranch(task);

/**
 * An agent's fork of the project, for all its changes on the task: named after
 * who opened them (a registered agent, a person, an access token, Blueprint's
 * builder), with a short hash when the name had to change to be a repo name.
 */
export async function agentForkName(taskId: string, author: string | undefined) {
	const who = author ?? "anonymous";
	// A registered agent goes by its name; other identities keep their kind (person-…, service-…), so they never collide with one.
	const name = who.replace(/^agent:/, "");
	const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
	if (slug === name) return `${taskId}--agent--${slug}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(who)));
	return `${taskId}--agent--${slug}-${[...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Forks of one project at once; beyond about 15, Artifacts fails some of them. */
const MAX_CONCURRENT_FORKS = 6;

/**
 * One Coordinator per task. It owns the task's state and runs every Git operation
 * on the task's repos: forking slices, test-merging them against each other
 * (Merge-ahead), gating integration on reviewer votes (Quorum), and landing.
 */

/** Set once an open task has moved to the elected coordinator: this object then decides nothing for it. */
const MOVED = "moved-to-elected";

/** Whether two claims are the same paths, in any order. */
const sameClaim = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((p, i) => p === [...b].sort()[i]);
export class Coordinator extends DurableObject<Env> implements CoordinatorHumanActions, LaneChangeCoordinator {
	// State-changing steps run one at a time so they never overwrite each other.
	// A step should be short: the hot paths (opening a change, recording a push,
	// abandoning) do their slow Git and agent I/O before or after their step,
	// and re-check what they read once they hold it. The ledger is written to
	// Git in the background, never under the lock.
	private tail: Promise<unknown> = Promise.resolve();

	private readonly stats = new LockStats();

	/** Decisions made by the running method, written to Git in the background when it finishes. */
	private readonly outbox = new LedgerOutbox(this.ctx, this.env, this.stats);

	/** Forks in progress, and openers waiting for a turn. */
	private forksRunning = 0;
	private forkWaiters: (() => void)[] = [];

	/**
	 * Run a state-changing step on its own: steps never interleave. The answer
	 * waits for whatever `finishStep` says makes the step's decisions durable,
	 * but the next step doesn't: it starts as soon as this one has run. With
	 * `early`, the answer doesn't wait either: for a step whose effects only
	 * matter once a later step's answer, which does wait, confirms them (steps
	 * become durable in order).
	 */
	protected exclusive<T>(fn: () => Promise<T>, label = "other", early = false): Promise<T> {
		const queued = Date.now();
		this.stats.depth++;
		let durable: Promise<void> = Promise.resolve();
		const recorded = async () => {
			const started = Date.now();
			let ran = started;
			let ok = false;
			try {
				const result = await fn();
				ran = Date.now();
				ok = true;
				return result;
			} catch (err) {
				ran = Date.now();
				throw err;
			} finally {
				({ durable } = await this.finishStep(ok));
				this.stats.depth--;
				this.stats.record({ label, at: queued, waitMs: started - queued, runMs: ran - started, flushMs: Date.now() - ran });
			}
		};
		const run = this.tail.then(recorded, recorded);
		this.tail = run.catch(() => {});
		return run.then(async (result) => {
			if (!early) await durable;
			// Answered early: a later step's answer reports the failure, if any.
			else void durable.catch(() => {});
			return result;
		});
	}

	// Where the task lives and how a step's decisions are kept. The fixed
	// Coordinator keeps the task in its own storage and writes decisions to Git
	// in the background; a peer of the elected coordinator overrides these to
	// keep both in the shared log (see src/peer.ts).

	/** The stored task, if there is one. */
	protected async readTask(): Promise<Task | undefined> {
		// An open task handed over to the elected coordinator is decided there now, never here.
		if (await this.ctx.storage.get(MOVED)) fail(409, "this task moved to the elected coordinator: its log in Git is the record now");
		return this.ctx.storage.get<Task>("task");
	}

	protected writeTask(task: Task): Promise<void> {
		return this.ctx.storage.put("task", task);
	}

	/** Keep a decision until its step finishes. */
	protected recordDecision(entry: LedgerEntry) {
		this.outbox.add(entry);
	}

	/**
	 * A step finished (or failed, `ok` false). Returns what its answer must wait
	 * for (wrapped, since awaiting a promise of a promise flattens it). Here:
	 * nothing, since decisions go to Git in the background. A method that failed
	 * didn't make its decisions; what it saved still goes out as state.
	 */
	protected async finishStep(ok: boolean): Promise<{ durable: Promise<void> }> {
		if (!ok) this.outbox.discard();
		await this.outbox.queue();
		return { durable: Promise.resolve() };
	}

	/** Wake this object at `at` (claim leases need checking). */
	protected setTimer(at: number): Promise<void> {
		return this.ctx.storage.setAlarm(at);
	}

	/** Run `fn` on the stored task under the lock, and save the task once it returns. A failure saves nothing. */
	private mutate<T>(fn: (task: Task) => Promise<T>, label?: string, early = false): Promise<T> {
		return this.exclusive(async () => {
			const task = await this.load();
			const result = await fn(task);
			await this.save(task);
			return result;
		}, label, early);
	}

	/** Note a decision on the commit it is about (the task's anchor commit for task-wide ones). */
	private note(task: Task, commit: string | undefined, text: string) {
		this.recordDecision({ commit: commit ?? task.baseCommit ?? task.anchor ?? EMPTY_TREE, text, at: new Date().toISOString() });
	}

	/**
	 * Hand an open task over to the elected coordinator (open mode has no fixed
	 * Coordinator): every queued decision is written to Git first, so the elected
	 * log continues from them; then this object stops its timers and refuses
	 * everything. Returns the task's state, the elected log's first. Harmless to
	 * repeat.
	 */
	async handOver() {
		await this.ledgerIdle();
		return this.exclusive(async () => {
			const task = (await this.ctx.storage.get<Task>("task")) ?? fail(404, "task not found");
			if (task.mode !== "open") fail(409, "only an open task moves to the elected coordinator");
			if (!(await this.ctx.storage.get(MOVED))) {
				await this.ctx.storage.put(MOVED, new Date().toISOString());
				await this.ctx.storage.deleteAlarm();
			}
			return withScheduling(task);
		});
	}

	/** Wait until every queued decision is in Git, retrying a failed write once. Returns how many are still queued. */
	ledgerIdle() {
		return this.outbox.idle();
	}

	/** Rebuild the task from its notes ref and compare it with the stored copy, once queued decisions are written. */
	async ledger() {
		await this.ledgerIdle();
		return this.exclusive(async () => {
			const task = await this.load();
			const messages = await readLedger(await remoteFor(this.env.ARTIFACTS, task.repo), task.id);
			const contracts = (await this.ctx.storage.get<Record<string, string>>("contracts")) ?? {};
			const mismatch = diff(replay(messages), toDoc(task, contracts));
			// Typed loosely: the recursive JSON type is too deep for the RPC stub's types.
			return { commits: messages.length, matches: mismatch === undefined, mismatch: (mismatch ?? null) as Record<string, unknown> | null };
		});
	}

	protected async load() {
		return withScheduling((await this.readTask()) ?? fail(404, "task not found"));
	}

	protected save(task: Task) {
		return this.writeTask(task);
	}

	private slice(task: Task, id: string) {
		return task.slices.find((s) => s.id === id) ?? fail(404, `no slice ${id}`);
	}

	/** A slice that must be building. `noun` names it in the refusal: a "slice", or an open-mode "change". */
	private buildingSlice(task: Task, id: string, noun = "slice") {
		const slice = this.slice(task, id);
		if (slice.status !== "building") fail(409, `${noun} ${id} is ${slice.status}`);
		return slice;
	}

	/** Flag a slice for a human: `attention` is shown on it, and the decision is noted as "needs a human: <summary>". */
	private flagHuman(task: Task, slice: Slice, commit: string | undefined, attention: string, summary = attention) {
		slice.attention = attention;
		this.note(task, commit, `${slice.id} needs a human: ${summary}`);
	}

	requestLaneChange(requesterSliceId: string, input: LaneChangeRequestInput) {
		return this.exclusive(async () => {
			const task = await this.load();
			const requester = this.buildingSlice(task, requesterSliceId);
			if (!input || typeof input.path !== "string" || !input.path.trim()) fail(400, "a lane request needs a path");
			if (!safeLanePath(input.path)) fail(400, `invalid relative path: ${input.path}`);
			if (typeof input.need !== "string" || !input.need.trim()) fail(400, "a lane request needs a nonempty need");
			if (typeof input.reason !== "string" || !input.reason.trim()) fail(400, "a lane request needs a nonempty reason");
			// Only active changes hold lanes; an integrated or abandoned change's paths are free.
			const owners = task.slices.filter((candidate) => candidate.status === "building" && inLane(input.path, candidate.owns));
			if (owners.length > 1) fail(409, `more than one slice owns ${input.path}: ${owners.map((x) => x.id).join(", ")}`);
			if (!owners.length) return { outcome: "no-owner" as const, message: `No active change holds ${input.path}. Extend your own claim to it (extend_claim) and change it yourself.` };
			const owner = owners[0];
			if (owner.id === requesterSliceId) fail(400, `${input.path} is in your own lane; a cross-lane request must name another slice file`);
			const request: LaneChangeRequest = { id: crypto.randomUUID().slice(0, 8), requester: requesterSliceId, owner: owner.id, path: input.path, need: input.need.trim(), reason: input.reason.trim(), status: "pending", createdAt: new Date().toISOString() };

			// Adding requester -> owner is unsafe if owner already depends (directly or
			// transitively) on requester. Pending and answered requests both wait.
			if (closesLaneRequestCycle(task, requesterSliceId, owner.id)) {
				request.status = "human";
				const message = "This cross-lane request would create a wait cycle or deadlock. It was not sent and needs a human to resolve the dependency.";
				await this.flagLaneRequest(task, request, message, false);
				this.note(task, requester.head, `Cross-lane request ${request.id} would create a wait cycle and was handed to a human`);
				await this.save(task);
				return { outcome: "human" as const, request, message };
			}

			task.laneChangeRequests = [...(task.laneChangeRequests ?? []), request];
			if (owner.status === "integrated") {
				request.status = "human";
				const message = `Slice ${owner.id} is already integrated; it can no longer make the requested change to ${request.path}. This request needs a human.`;
				await this.flagLaneRequest(task, request, message, false);
				this.note(task, owner.head, `Cross-lane request ${request.id} from ${requesterSliceId} to integrated slice ${owner.id} needs a human: ${request.path} (${request.need})`);
				await this.save(task);
				return { outcome: "human" as const, request, message };
			}
			const message = laneRequestMessage(request);
			let delivery: "inbox" | "resumed";
			try {
				const wake = await this.wakeBuilder(task, owner, `lane-request:${request.id}`, message);
				delivery = wake === "resumed" ? "resumed" : "inbox";
			}
			catch (err) {
				request.status = "human";
				const explanation = `Could not deliver the cross-lane request to slice ${owner.id}: ${statusOf(err).message}. This request needs a human.`;
				await this.flagLaneRequest(task, request, explanation, false);
				this.note(task, owner.head, `Cross-lane request ${request.id} could not be delivered to owner ${owner.id} and needs a human`);
				await this.save(task);
				return { outcome: "human" as const, request, message: explanation };
			}
			this.note(task, owner.head, `Cross-lane request ${request.id}: slice ${requesterSliceId} asked slice ${owner.id} to change ${request.path}: ${request.need}. Reason: ${request.reason} (${delivery})`);
			await this.save(task);
			return { outcome: "requested" as const, request, delivery, message };
		});
	}

	answerLaneChange(ownerSliceId: string, requestId: string, answer: LaneChangeAnswer) {
		return this.mutate(async (task) => {
			const owner = this.slice(task, ownerSliceId);
			const request = (task.laneChangeRequests ?? []).find((item) => item.id === requestId) ?? fail(404, `no lane request ${requestId}`);
			if (request.owner !== ownerSliceId) fail(403, `slice ${ownerSliceId} does not own lane request ${requestId}`);
			if (request.status !== "pending") fail(409, `lane request ${requestId} is ${request.status}`);
			if (owner.status === "integrated") {
				const message = `Slice ${ownerSliceId} is already integrated and can no longer change ${request.path}; this request needs a human.`;
				await this.flagLaneRequest(task, request, message, true);
				return request;
			}
			if (owner.status !== "building") fail(409, `slice ${ownerSliceId} is ${owner.status}`);
			if (!answer || (answer.outcome !== "done" && answer.outcome !== "declined")) fail(400, "lane request answer must be done or declined");
			if (typeof answer.answer !== "string" || !answer.answer.trim()) fail(400, "a lane request answer needs a nonempty explanation");
			request.answer = answer.answer.trim();
			request.answeredAt = new Date().toISOString();
			if (answer.outcome === "declined") {
				request.status = "declined";
				const message = `Slice ${ownerSliceId} declined cross-lane request ${request.id} for ${request.path}: ${request.answer}`;
				await this.wakeLaneRequester(task, request, message);
				this.note(task, owner.head, `Cross-lane request ${request.id} declined by slice ${ownerSliceId}; requester ${request.requester} was notified: ${request.answer}`);
			} else {
				// Agent-supplied commit IDs are untrusted. Only Artifacts' current fork
				// head proves what was actually pushed by the owner.
				const pushedHead = await this.changeHead(task, owner);
				if (!pushedHead || pushedHead === task.baseCommit) fail(409, "a done answer requires a current pushed change commit in the owner's fork");
				request.status = "answered";
				request.answerCommit = pushedHead;
				this.note(task, pushedHead, `Slice ${ownerSliceId} answered cross-lane request ${request.id} as done for ${request.path} at pushed commit ${pushedHead}: ${request.answer}`);
			}
			return request;
		});
	}

	private toInbox(slice: Slice, text: string): "inbox" {
		slice.inbox = [...(slice.inbox ?? []), { at: new Date().toISOString(), text }].slice(-50);
		return "inbox";
	}

	/** An external agent reads its messages (review findings, requests, human messages), optionally only newer ones. */
	async readInbox(sliceId: string, since?: string) {
		const task = await this.load();
		const slice = this.slice(task, sliceId);
		return (slice.inbox ?? []).filter((m) => !since || m.at > since);
	}

	/** A builder's Git access for three hours: write to its own fork, read the task base. */
	private builderRemotes(task: Task, slice: Slice): Promise<[Remote, Remote]> {
		return Promise.all([
			remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600),
			remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3 * 3600),
		]);
	}

	/** Fresh tokens for a builder that resumes its conversation. */
	private async resumeCredentials(task: Task, slice: Slice): Promise<BuilderResumeCredentials> {
		const [write, base] = await this.builderRemotes(task, slice);
		return { token: write.token, base: { remote: base.url, token: base.token } };
	}

	private queueWake(slice: Slice, eventId: string, message: string) {
		if (!(slice.wakeOutbox ?? []).some((event) => event.eventId === eventId)) slice.wakeOutbox = [...(slice.wakeOutbox ?? []), { eventId, message }];
	}

	private ensureBuilderQueued(task: Task, slice: Slice) {
		if (!task.queue.some((item) => item.kind === "builder" && item.slice === slice.id)) task.queue.push({ kind: "builder", slice: slice.id });
	}

	/**
	 * Deliver a stable wake event exactly once, whether its builder is parked or
	 * already working. The event waits in the slice's outbox until Builder.wake
	 * confirms it; a failure keeps it (and any later events) for a retry.
	 */
	private async wakeBuilder(task: Task, slice: Slice, eventId: string, message: string): Promise<"inbox" | "resumed" | "deferred"> {
		if ((slice.wakeEventIds ?? []).includes(eventId)) return "inbox";
		// An external agent has no hosted builder to wake: it reads its inbox.
		if (slice.external) {
			slice.wakeEventIds = [...new Set([...(slice.wakeEventIds ?? []), eventId])].slice(-200);
			return this.toInbox(slice, message);
		}
		this.queueWake(slice, eventId, message);
		if (!task.active.builders.includes(slice.id) && !hasRoom(task, "builder")) {
			this.ensureBuilderQueued(task, slice);
			return "deferred";
		}
		return this.deliverOutbox(task, slice);
	}

	/** Send the slice's outbox to its builder, in order, removing each event only once it is delivered. */
	private async deliverOutbox(task: Task, slice: Slice): Promise<"inbox" | "resumed" | "deferred"> {
		const builder = this.env.BUILDER.getByName(agentsOf(task, slice));
		const wasParked = !!slice.parkedAt;
		let resumed = false;
		let credentials: BuilderResumeCredentials;
		try {
			credentials = await this.resumeCredentials(task, slice);
		} catch (err) {
			console.error(`credentials for slice ${slice.id}'s builder failed; its wake events wait in the queue: ${statusOf(err).message}`, err);
			this.ensureBuilderQueued(task, slice);
			return "deferred";
		}
		while (slice.wakeOutbox?.length) {
			const event = slice.wakeOutbox[0];
			let result: "resumed" | "deferred" | "ignored";
			try {
				result = await retryTransient(() => builder.wake(event.eventId, event.message, credentials));
			} catch (err) {
				console.error(`wake event ${event.eventId} for slice ${slice.id} failed; it waits in the queue: ${statusOf(err).message}`, err);
				this.ensureBuilderQueued(task, slice);
				return "deferred";
			}
			slice.wakeOutbox = slice.wakeOutbox.slice(1);
			slice.wakeEventIds = [...new Set([...(slice.wakeEventIds ?? []), event.eventId])].slice(-200);
			if (result === "resumed") resumed = true;
		}
		slice.wakeOutbox = undefined;
		if (wasParked) {
			// "ignored" can mean an earlier delivery already resumed it before a restart lost our write: ask the builder.
			const state = await builder.state();
			if (state && (state.status === "queued" || state.status === "working")) {
				slice.parkedAt = undefined;
				slice.parkedWaitingFor = undefined;
				if (!task.active.builders.includes(slice.id)) task.active.builders.push(slice.id);
				this.note(task, slice.head, `Builder for slice ${slice.id} resumed from parking`);
			}
		} else if (!task.active.builders.includes(slice.id)) {
			const state = await builder.state();
			if (state && (state.status === "queued" || state.status === "working")) task.active.builders.push(slice.id);
		}
		return resumed ? "resumed" : "inbox";
	}

	private async wakeLaneRequester(task: Task, request: LaneChangeRequest, message: string) {
		const requester = this.slice(task, request.requester);
		if (request.status !== "human") requester.attention = undefined;
		if (requester.status !== "building") return;
		const eventId = `lane-change:${request.id}:${request.status}`;
		try {
			const delivery = await this.wakeBuilder(task, requester, eventId, message);
			this.note(task, requester.head, `Cross-lane request ${request.id} resolution ${request.status} delivered to slice ${requester.id} (${delivery})`);
		} catch (err) {
			requester.attention = `Cross-lane request resolution could not be delivered: ${statusOf(err).message}`;
			this.note(task, requester.head, `Could not deliver resolution event ${eventId} to slice ${requester.id}; attention is needed`);
		}
	}


	private async flagLaneRequest(task: Task, request: LaneChangeRequest, message: string, notify: boolean, human = true) {
		if (human) request.status = "human";
		const requester = this.slice(task, request.requester);
		requester.attention = message;
		if (notify && requester.status === "building") await this.wakeLaneRequester(task, request, message);
		this.note(task, requester.head, `Cross-lane request ${request.id} for ${request.path} needs a human: ${message}`);
	}

	parkBuilder(sliceId: string): Promise<ParkBuilderResult> {
		return this.exclusive(async () => {
			const task = await this.load();
			return this.parkBuilderLocked(task, sliceId);
		});
	}

	private async parkBuilderLocked(task: Task, sliceId: string): Promise<ParkBuilderResult> {
		const slice = this.slice(task, sliceId);
		const outgoing = unresolvedRequests(task, sliceId);
		if (!outgoing.length) {
			const resolutions = latestResolutions(task, sliceId);
			const detail = resolutions.map((resolution) => `${resolution.status}: ${resolution.message}`).join("; ");
			return { outcome: "refused", reason: resolutions.length ? `A request resolved before parking took effect (${detail} ).` : "There are no unresolved outgoing cross-lane requests to wait for.", ...(resolutions.length ? { resolutions } : {}) };
		}
		if (slice.status !== "building") return { outcome: "refused", reason: `Slice ${sliceId} is ${slice.status}, not building.` };
		if (slice.parkedAt) return { outcome: "refused", reason: "The builder is already parked.", resolutions: [] };
		if (slice.wakeOutbox?.length) {
			this.ensureBuilderQueued(task, slice);
			return { outcome: "refused", reason: "Messages are waiting to be delivered to you; read them before parking.", resolutions: [] };
		}
		const parkedAt = new Date().toISOString();
		const waitingFor = outgoing.map((request) => request.id);
		const builder = this.env.BUILDER.getByName(agentsOf(task, slice));
		await builder.park(parkedAt, waitingFor);
		slice.parkedAt = parkedAt;
		slice.parkedWaitingFor = waitingFor;
		removeKey(task.active.builders, sliceId);
		this.note(task, slice.head, `Builder for slice ${sliceId} parked at ${parkedAt} waiting for cross-lane requests ${waitingFor.join(", ")}`);
		await this.save(task);
		await this.drain(task);
		await this.save(task);
		return { outcome: "parked", parkedAt, waitingFor };
	}

	private async autoParkWaitingBuilder(task: Task, slice: Slice) {
		const waiting = unresolvedRequests(task, slice.id).length > 0;
		if (!waiting || slice.status !== "building" || slice.parkedAt) return false;
		// Only auto-park when the fork is exactly at the Coordinator's recorded
		// head; Builder.park performs the additional local dirty/unpushed check.
		const forkHead = await this.changeHead(task, slice);
		if (!forkHead || forkHead !== slice.head) return false;
		try {
			const result = await this.parkBuilderLocked(task, slice.id);
			if (result.outcome !== "parked") return false;
			this.note(task, slice.head, `Slice ${slice.id} automatically parked while waiting for its unresolved cross-lane requests`);
			return true;
		} catch (err) {
			console.error(`auto-parking slice ${slice.id}'s builder failed: ${statusOf(err).message}`, err);
			return false;
		}
	}

	parkedBuilderTimedOut(sliceId: string, parkedAt: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			if (!slice.parkedAt || slice.parkedAt !== parkedAt) return;
			// Deliver anything waiting first: it may resolve what the builder is waiting for.
			if (slice.wakeOutbox?.length) {
				this.ensureBuilderQueued(task, slice);
				await this.drain(task);
				await this.save(task);
				if (!slice.parkedAt) return;
			}
			if (slice.parkTimeoutFlagged === parkedAt) return;
			const unresolved = unresolvedRequests(task, sliceId);
			if (!unresolved.length) return;
			// Tell the builder too, but never let its answer decide whether a human is flagged.
			await this.env.BUILDER.getByName(agentsOf(task, slice))
				.markParkTimedOut()
				.catch((err) => console.error(`telling slice ${sliceId}'s builder its park timed out failed: ${statusOf(err).message}`, err));
			const waiting = unresolved.map((request) => `${request.id} (${request.path})`).join(", ");
			const message = `Builder has been parked for more than ${Math.round(BUILDER_PARK_TIMEOUT_MS / 60_000)} minutes waiting for cross-lane requests ${waiting}; human attention is needed.`;
			// The flag, the marker and the note are written together in one save.
			slice.attention = message;
			slice.parkTimeoutFlagged = parkedAt;
			this.note(task, slice.head, `${slice.id} parked timeout: ${message}`);
			await this.save(task);
		});
	}

	state() {
		return this.load();
	}

	/**
	 * Delete this task's state for good, so the task can be removed. Refused
	 * while any agent or gate is at work on it. Its forks and its dashboard
	 * entry are the caller's to remove; deleting again is harmless.
	 */
	destroy() {
		return this.exclusive(async () => {
			const stored = await this.ctx.storage.get<Task>("task");
			if (!stored) return { id: null, repo: null };
			// Tasks from before scheduling existed have no queue or active lists; fill them in.
			const task = withScheduling(stored);
			const busy = [
				...task.active.builders.map((b) => `builder ${b}`),
				...task.active.reviewers.map((r) => `reviewer ${r}`),
				...task.slices.filter((s) => s.status === "opening").map((s) => `change ${s.id} being opened`),
				...task.slices.filter((s) => s.gate && ["queued", "running"].includes(s.gate.status)).map((s) => `${s.id}'s gate`),
			];
			if (busy.length) fail(409, `task ${task.id} is still at work: ${busy.join(", ")}`);
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			this.outbox.discard();
			return { id: task.id, repo: task.repo };
		}, "destroy");
	}

	/** Lock timings since the last reset, oldest first. Kept in memory only, so they reset when the object restarts. */
	lockStats(reset = false) {
		return this.stats.read(reset);
	}

	/** Diff the human-blocked slice's pinned review commit, never its moving head. */
	/** A change's diff, for people to read: the commit under review, or before review the latest push. */
	async sliceDiff(sliceId: string) {
		const task = await this.load();
		const slice = this.slice(task, sliceId);
		const head = slice.reviewHead ?? slice.head;
		if (!head) fail(409, `change ${sliceId} has nothing pushed yet`);
		const base = slice.mergeBase ?? task.baseCommit;
		if (!base) fail(409, `change ${sliceId} has no base to compare with`);
		if (!slice.repo) fail(409, `change ${sliceId} has no repository`);
		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, slice.repo, "read"), changeRef(task, slice));
		const files = await ws.changedFiles(base, head);
		return { base, head, ...boundedUnifiedDiff(files) };
	}

	/**
	 * Open a change: claim paths as the change's lane and fork the project for
	 * it. Refused, with who holds what, if an active change holds any of the
	 * paths. Returns write credentials for the agent; with `hosted`, a builder
	 * agent is started on it as well.
	 */
	async openChange(input: { id?: string; title: string; intent: string; owns: string[]; hosted?: boolean; agent?: string; authorAgent?: string }, actor?: AccessIdentity) {
		// Asked again for a change that already opened (its answer was lost, say,
		// with the leader that gave it): the same change, with fresh credentials.
		if (input.id !== undefined) {
			const opened = (await this.load()).slices.find((s) => s.id === input.id);
			if (opened?.status === "building" && sameClaim(opened.owns, normalizeClaim(input.owns))) {
				return { change: opened, credentials: await this.changeCredentials(await this.load(), opened) };
			}
		}
		// Whose change it is decides its fork: the author's own, shared by all their changes.
		const authorBy = input.authorAgent ? `agent:${input.authorAgent}` : actor ? identityLabel(actor) : input.hosted ? "blueprint-builder" : undefined;
		const forkName = await agentForkName((await this.load()).id, authorBy);
		// Reserve: the paths are held from here, so a racing claim is refused while
		// the fork is made. Answered before the reservation is durable, so the fork
		// starts at once; the confirm step's answer waits for both, in order.
		const { id, repo, title, resumed } = await this.mutate(async (task) => {
			if (task.mode !== "open") fail(409, "changes can only be opened on an open-mode task");
			if (typeof input?.title !== "string" || !input.title.trim()) fail(400, "a change needs a title");
			if (typeof input.intent !== "string" || !input.intent.trim()) fail(400, "a change needs an intent: what it sets out to do");
			// A registered agent (its key checked by the caller) is the change's author; otherwise whoever Access says called.
			const agent = agentName(input.authorAgent ?? input.agent);
			if (!input.authorAgent && agent && task.agents?.[agent]) fail(403, `${agent} is a registered agent: open the change with its key`);
			const owns = normalizeClaim(input.owns);
			// Asked again while its reservation stands (interrupted before it confirmed): carry on from there.
			const reserved = input.id !== undefined ? task.slices.find((s) => s.id === input.id) : undefined;
			if (reserved?.status === "opening" && sameClaim(reserved.owns, owns)) {
				reserved.leaseUntil = new Date(Date.now() + OPENING_LEASE_MS).toISOString();
				return { id: reserved.id, repo: reserved.repo!, title: reserved.title, resumed: true };
			}
			const conflicts = claimConflicts(task, owns);
			if (conflicts.length) fail(409, claimConflictMessage(conflicts));

			// The caller may choose the id (a peer of the elected coordinator is named after its change).
			let id = input.id ?? changeId(input.title);
			if (input.id !== undefined) {
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id) || input.id.length > 40) fail(400, `invalid change id: ${input.id}`);
				if (task.slices.some((s) => s.id === input.id)) fail(409, `change ${input.id} already exists`);
			}
			while (task.slices.some((s) => s.id === id)) id = changeId(input.title);
			const slice: Slice = {
				id,
				title: input.title.trim(),
				owns,
				instructions: input.intent.trim(),
				intent: input.intent.trim(),
				tests: [],
				status: "opening",
				repo: forkName,
				ref: `changes/${id}`,
				touched: [],
				outOfLane: [],
				reviews: [],
				leaseUntil: new Date(Date.now() + OPENING_LEASE_MS).toISOString(),
				external: !input.hosted,
				openedAt: new Date().toISOString(),
				// A person by a hash of their email: change records reach agents, never the address.
				...(actor ? { openedBy: identityLabel(actor) } : input.hosted ? { openedBy: "blueprint-builder" } : {}),
				...(agent ? { agent } : {}),
				...(authorBy ? { authorBy } : {}),
			};
			task.slices.push(slice);
			await this.scheduleLeaseCheck(task);
			return { id, repo: slice.repo!, title: slice.title, resumed: false };
		}, "open:reserve", true);

		// The author's fork: made on their first change, reused after. Without the lock: making one takes seconds.
		let start: string;
		try {
			const current = await this.load();
			const project = current.repo;
			const exists = await remoteFor(this.env.ARTIFACTS, repo, "write").then(() => true, () => false);
			if (!exists)
				await this.withForkSlot(() => forkAndWait(this.env.ARTIFACTS, project, repo, `${authorBy ?? "an agent"}'s changes on ${project}`)).catch(async (err) => {
					// Another of their changes made it meanwhile.
					if (!(await remoteFor(this.env.ARTIFACTS, repo, "write").then(() => true, () => false))) throw err;
				});
			// The change starts from the project as it is now; its branch changes/<id> starts there.
			start = (await headOf(this.env.ARTIFACTS, project, projectBranch(current))) ?? fail(500, `${project} has no commits`);
		} catch (err) {
			await this.mutate(async (task) => {
				task.slices = task.slices.filter((s) => !(s.id === id && s.status === "opening"));
			}, "open:release");
			throw err;
		}

		// Confirm: the reservation becomes an open change.
		return this.mutate(async (task) => {
			const slice = this.slice(task, id);
			if (slice.status !== "opening") fail(409, `change ${id} was ${slice.status} before its fork was ready; open it again`);
			slice.status = "building";
			slice.head = start;
			slice.startCommit = start;
			slice.leaseUntil = leaseUntil(task);
			this.note(task, start, `Change ${id} opened${actor ? ` by ${accessIdentityLabel(actor)}` : ""}: "${slice.title}", claiming ${slice.owns.join(", ")}. Intent: ${slice.intent}`);
			if (input.hosted) await this.schedule(task, { kind: "builder", slice: id });
			await this.scheduleLeaseCheck(task);
			return { change: slice, credentials: await this.changeCredentials(task, slice) };
		}, "open:confirm");
	}

	/** What an agent needs to work on its change: write access to its fork and the branch to push, and read access to the project to start from. */
	private async changeCredentials(task: Task, slice: Slice): Promise<SliceCredentials> {
		const [fork, project] = await Promise.all([remoteFor(this.env.ARTIFACTS, slice.repo!, "write", 3 * 3600), remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3 * 3600)]);
		return { slice: slice.id, repo: slice.repo!, remote: fork.url, token: fork.token, ref: changeRef(task, slice), project: { remote: project.url, token: project.token, branch: projectBranch(task) } };
	}

	/** The head of a change's branch in its fork, or null before anything is pushed. */
	private async changeHead(task: Task, slice: Slice) {
		if (!slice.ref) return headOf(this.env.ARTIFACTS, slice.repo!, projectBranch(task));
		return branchHead(await remoteFor(this.env.ARTIFACTS, slice.repo!, "read"), slice.ref);
	}

	/**
	 * Run a fork when fewer than MAX_CONCURRENT_FORKS are running. Artifacts fails
	 * some forks of one repo when many run at once, so a burst of new changes
	 * forks a few at a time. Only opening waits here; nothing holds the lock.
	 */
	private async withForkSlot<T>(fork: () => Promise<T>): Promise<T> {
		while (this.forksRunning >= MAX_CONCURRENT_FORKS) await new Promise<void>((resolve) => this.forkWaiters.push(resolve));
		this.forksRunning++;
		try {
			return await fork();
		} finally {
			this.forksRunning--;
			this.forkWaiters.shift()?.();
		}
	}

	/** Fresh write access to an external agent's own fork (with the branch to push), and read access to the project. */
	externalCredentials(sliceId: string) {
		return this.mutate(async (task) => {
			const slice = this.slice(task, sliceId);
			if (!slice.external) fail(403, `change ${sliceId} is built by a hosted agent`);
			if (slice.status !== "building") fail(409, `change ${sliceId} is ${slice.status}`);
			const credentials = await this.changeCredentials(task, slice);
			this.renewLease(task, slice);
			return { fork: credentials.remote, token: credentials.token, branch: credentials.ref, project: credentials.project };
		});
	}

	/**
	 * Change the task's settings: its review policy, its checks, how long a claim
	 * lasts without activity. A commit already in review keeps the policy it went
	 * to review under. Recorded in the task's log with who changed what.
	 */
	updateSettings(input: { review?: ReviewPolicy; verify?: string[]; leaseMinutes?: number }, actor?: AccessIdentity) {
		return this.mutate(async (task) => {
			const changed: string[] = [];
			if (input.review !== undefined) {
				const review = { ...input.review, vetoes: input.review.vetoes ?? [], reviewers: input.review.reviewers ?? [] };
				validatePolicy(review);
				task.review = review;
				changed.push(`review: ${review.required} of ${review.reviewers.join(", ") || "no reviewers"}${review.vetoes.length ? `, ${review.vetoes.join(", ")} can veto` : ""}${review.external?.length ? `, outside agents review ${review.external.join(", ")}` : ""}${review.escalate?.length ? `, stricter for ${review.escalate.flatMap((e) => e.paths).join(", ")}` : ""}`);
			}
			if (input.verify !== undefined) {
				if (!Array.isArray(input.verify) || !input.verify.every((c) => typeof c === "string")) fail(400, "verify is a list of commands");
				task.verify = input.verify.map((c) => c.trim()).filter(Boolean);
				changed.push(`checks: ${task.verify.join("; ") || "none"}`);
			}
			if (input.leaseMinutes !== undefined) {
				if (!Number.isInteger(input.leaseMinutes) || input.leaseMinutes < 5 || input.leaseMinutes > 1440) fail(400, "leaseMinutes must be a whole number from 5 to 1440");
				task.leaseMinutes = input.leaseMinutes;
				changed.push(`claims last ${input.leaseMinutes} minutes without activity`);
			}
			if (!changed.length) fail(400, "nothing to change: send review, verify or leaseMinutes");
			this.note(task, task.anchor, `Settings changed${actor ? ` by ${identityLabel(actor)}` : ""}: ${changed.join("; ")}`);
			return { review: task.review, verify: task.verify, leaseMinutes: task.leaseMinutes };
		});
	}

	/**
	 * Register an outside agent on the task under `name`, bound to a key the
	 * caller keeps (only its hash is stored). Registering a name again rotates its
	 * key, and needs the current one.
	 */
	registerAgent(name: string, keyHash: string, currentKeyHash?: string, actor?: AccessIdentity) {
		return this.mutate(async (task) => {
			const agent = agentName(name) ?? fail(400, "an agent needs a name");
			const existing = task.agents?.[agent];
			if (existing && existing.keyHash !== currentKeyHash) fail(403, `${agent} is already registered: send its current key to rotate it`);
			task.agents = { ...task.agents, [agent]: { keyHash, at: new Date().toISOString(), ...(actor ? { by: identityLabel(actor) } : {}) } };
			this.note(task, task.anchor, existing ? `Agent ${agent} rotated its key` : `Agent ${agent} registered`);
			return { agent, rotated: !!existing };
		});
	}

	/** Add paths to a change's claim, if no other active change holds them. */
	extendClaim(sliceId: string, paths: string[]) {
		return this.mutate(async (task) => {
			if (task.mode !== "open") fail(409, "claims can only be extended in open mode; planned lanes are fixed");
			const slice = this.buildingSlice(task, sliceId, "change");
			// Paths already inside the change's own lane need no new claim.
			const fresh = normalizeClaim(paths).filter((p) => !inLane(p, slice.owns));
			const conflicts = claimConflicts(task, fresh, slice.id);
			if (conflicts.length) fail(409, claimConflictMessage(conflicts));
			if (fresh.length) {
				slice.owns = [...slice.owns, ...fresh];
				this.note(task, slice.head, `Change ${slice.id} extended its claim to ${fresh.join(", ")}`);
			}
			this.renewLease(task, slice);
			await this.scheduleLeaseCheck(task);
			return slice;
		});
	}

	/** Give up a change: its lane is freed and its agents are stopped. */
	async abandonChange(sliceId: string, reason: string, actor?: AccessIdentity) {
		// Asked again after it went through (its answer was lost): the change, as abandoned.
		const already = (await this.load()).slices.find((s) => s.id === sliceId);
		if (already?.status === "abandoned") return already;
		const { slice, stopAgents } = await this.mutate(async (task) => {
			if (task.mode !== "open") fail(409, "only open-mode changes can be abandoned");
			if (typeof reason !== "string" || !reason.trim()) fail(400, "abandoning a change needs a reason");
			const slice = this.buildingSlice(task, sliceId, "change");
			const stopAgents = this.abandon(task, slice, `${reason.trim()}${actor ? ` (by ${accessIdentityLabel(actor)})` : ""}`);
			return { slice, stopAgents };
		}, "abandon");
		// The lane is already free; stopping the change's agents needn't hold up anyone else.
		await stopAgents();
		return slice;
	}

	/** Claims held by active changes, for agents deciding what to claim. */
	async claims() {
		return claimsOf(await this.load());
	}

	/**
	 * Mark a change abandoned and free its lane and agent slots. Returns a
	 * function that stops its agents, for the caller to run once it has saved
	 * and let go of the lock.
	 */
	private abandon(task: Task, slice: Slice, reason: string): () => Promise<unknown> {
		const opened = slice.status === "building";
		slice.status = "abandoned";
		slice.endedAt = new Date().toISOString();
		slice.attention = undefined;
		task.queue = task.queue.filter((item) => item.slice !== slice.id);
		task.active.builders = task.active.builders.filter((key) => key !== slice.id);
		task.active.reviewers = task.active.reviewers.filter((key) => !key.startsWith(`${slice.id}:`));
		this.note(task, slice.head, `Change ${slice.id} abandoned, freeing ${slice.owns.join(", ")}: ${reason}`);
		const repo = agentsOf(task, slice);
		const reviewHead = slice.reviewHead;
		const roles = hostedRoles(policyFor(task, slice));
		// A change still being opened has no agents yet.
		if (!opened) return async () => {};
		return () =>
			Promise.allSettled([
				this.env.BUILDER.getByName(repo).cancel(`the change was abandoned: ${reason}`),
				...(reviewHead ? this.cancelReviewers(repo, roles, reviewHead, "the change was abandoned") : []),
			]);
	}

	/** Ask the reviewers of one commit to stop. Returns each cancellation, for the caller to settle. */
	private cancelReviewers(repo: string, roles: string[], head: string, reason: string) {
		return roles.map((role) => this.env.REVIEWER.getByName(reviewerName(repo, role, head)).cancel(reason));
	}

	private renewLease(task: Task, slice: Slice) {
		if (task.mode === "open" && slice.status === "building") slice.leaseUntil = leaseUntil(task);
	}

	/** Wake up when the next claim could expire. Open tasks never plan, so the alarm is free for this. */
	private async scheduleLeaseCheck(task: Task) {
		if (task.mode !== "open") return;
		const next = nextLeaseCheck(task);
		if (next !== null) await this.setTimer(Math.max(next, Date.now() + 1_000));
	}

	/**
	 * Expire claims whose lease ran out. A change that is waiting on review, the
	 * gate or another change keeps its claim, and its lease is renewed instead.
	 */
	private async sweepLeases() {
		const stops = await this.mutate(async (task) => {
			const now = Date.now();
			const stops: (() => Promise<unknown>)[] = [];
			await this.restartStalledGates(task, now);
			// External reviews that never came: a person decides (review it, waive it, or wait more).
			for (const slice of task.slices) {
				if ((externalReviewCheck(slice) ?? Infinity) > now) continue;
				const roles = awaitedExternalRoles(slice);
				slice.externalWaitFlagged = slice.reviewHead;
				this.flagHuman(task, slice, slice.reviewHead, `No outside reviewer has reviewed ${short(slice.reviewHead!)} as ${roles.join(", ")} in ${Math.round((now - Date.parse(slice.reviewRequestedAt!)) / 60_000)} minutes. Review it yourself, approve it without full review, or have a reviewer agent take it from review_queue.`, `waiting on external review (${roles.join(", ")})`);
			}
			for (const slice of task.slices) {
				if (!holdsClaim(slice) || !slice.leaseUntil || Date.parse(slice.leaseUntil) > now) continue;
				// A reservation this old lost its opener (the object restarted while forking).
				if (slice.status === "opening") stops.push(this.abandon(task, slice, "it was never finished opening"));
				else if (leaseExpired(task, slice, now)) stops.push(this.abandon(task, slice, `its claim expired after ${task.leaseMinutes ?? 30} minutes without activity`));
				else this.renewLease(task, slice);
			}
			await this.scheduleLeaseCheck(task);
			return stops;
		}, "sweep");
		await Promise.all(stops.map((stop) => stop()));
	}

	/**
	 * Checks queued or running long past GATE_STALL_MS: if the gate still holds
	 * the run, note it was seen and look again later; if not, its result was
	 * lost, so queue the checks again. Caller holds the lock and saves.
	 */
	private async restartStalledGates(task: Task, now: number) {
		const stalled = task.slices.filter((s) => (gateStallCheck(s) ?? Infinity) <= now);
		if (!stalled.length) return;
		const { queue, current } = await this.env.GATE.getByName(task.id).state();
		const held = [current, ...queue].filter((item) => item !== null);
		for (const slice of stalled) {
			const gate = slice.gate!;
			if (held.some((item) => [{ slice: item.slice, head: item.head }, ...(item.group ?? [])].some((m) => m.slice === slice.id && m.head === gate.head))) {
				slice.gate = { ...gate, seenAt: new Date(now).toISOString() };
				continue;
			}
			this.note(task, gate.head, `${slice.id}: its checks reported nothing for ${Math.round((now - Date.parse(gate.seenAt ?? gate.at)) / 60_000)} minutes and the gate no longer holds them; queued again`);
			// A group's lead re-queues the whole group; its members wait on that.
			if (gate.group?.length) {
				const members = gate.group.map((id) => task.slices.find((s) => s.id === id)).filter((s): s is Slice => !!s && s.status === "building" && !!s.reviewHead);
				if (members.length === gate.group.length && !stalled.some((s) => gate.group!.includes(s.id) && s.id < slice.id)) await this.startGroupGate(task, slice, members);
			} else await this.startGate(task, slice);
		}
	}

	/** The task's one timer: claim leases, swept when the earliest is due. */
	async alarm() {
		if (await this.ctx.storage.get(MOVED)) return;
		return this.sweepLeases();
	}

	private async launchBuilder(task: Task, slice: Slice) {
		if (slice.parkedAt) {
			// A parked builder resumes through its wake events, never through a fresh start.
			await this.deliverOutbox(task, slice);
			if (slice.parkedAt) removeKey(task.active.builders, slice.id);
			return;
		}
		const [remote, base] = await this.builderRemotes(task, slice);
		const job: BuildJob = {
			...sliceJobBase(task, slice),
			remote: remote.url,
			token: remote.token,
			base: { remote: base.url, token: base.token },
		};
		await this.env.BUILDER.getByName(agentsOf(task, slice)).start(job);
		if (slice.wakeOutbox?.length) await this.deliverOutbox(task, slice);
	}

	private async launchReviewer(task: Task, slice: Slice, role: string, head: string) {
		const remote = await remoteFor(this.env.ARTIFACTS, slice.repo!, "read", 3 * 3600);
		const job: ReviewJob = {
			...sliceJobBase(task, slice),
			remote: remote.url,
			token: remote.token,
			role,
			head,
			baseCommit: slice.mergeBase ?? slice.startCommit ?? task.baseCommit!,
			buildSummary: slice.buildSummary,
			revision: slice.revisions ?? 0,
			priorFindings: slice.revisions ? slice.lastFeedback : undefined,
		};
		await this.env.REVIEWER.getByName(reviewerName(agentsOf(task, slice), role, head)).start(job);
	}

	/**
	 * Start agent work if the task's limit allows, otherwise queue it. Work
	 * already running or queued is not started twice. Caller holds the lock and saves.
	 */
	private async schedule(task: Task, item: QueueItem, failures?: string[]): Promise<"started" | "queued" | "already"> {
		const key = itemKey(item);
		if (activeOf(task, item.kind).includes(key) || task.queue.some((q) => itemKey(q) === key)) return "already";
		if (!hasRoom(task, item.kind)) {
			task.queue.push(item);
			return "queued";
		}
		const failure = await this.launch(task, item);
		if (failure) failures?.push(failure);
		return "started";
	}

	/** Start an agent in a slot. A start that fails frees the slot, flags the slice, and returns why. */
	private async launch(task: Task, item: QueueItem): Promise<string | undefined> {
		const key = itemKey(item);
		const slice = this.slice(task, item.slice);
		activeOf(task, item.kind).push(key);
		try {
			if (item.kind === "builder") await this.launchBuilder(task, slice);
			else await this.launchReviewer(task, slice, item.role, item.head);
		} catch (err) {
			removeKey(activeOf(task, item.kind), key);
			if (item.kind === "builder" && slice.wakeOutbox?.length) this.ensureBuilderQueued(task, slice);
			const failure = `Could not start ${item.kind} ${key}: ${statusOf(err).message}`;
			this.flagHuman(task, slice, slice.head, failure);
			return failure;
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
			if (!running(state)) removeKey(task.active.builders, key);
		}
		for (const key of [...task.active.reviewers]) {
			const [slice, role, head] = key.split(":");
			const state = await this.env.REVIEWER.getByName(reviewerName(sliceRepoName(task.id, slice), role, head)).state();
			if (!running(state)) removeKey(task.active.reviewers, key);
		}
	}

	/**
	 * An agent stopped (finished, failed or was cancelled): free its slot and
	 * start queued work. A reviewer that failed without voting, on the commit
	 * still under review, runs once more; failing again, the change waits on a
	 * person, rather than on a vote that will never come.
	 */
	agentStopped(kind: AgentKind, key: string, failure?: string) {
		return this.mutate(async (task) => {
			removeKey(activeOf(task, kind), key);
			if (kind === "builder") {
				const slice = task.slices.find((candidate) => candidate.id === key);
				if (slice && !slice.parkedAt) await this.autoParkWaitingBuilder(task, slice);
			}
			if (kind === "reviewer" && failure !== undefined) await this.reviewerFailed(task, key, failure);
			await this.drain(task);
		});
	}

	private async reviewerFailed(task: Task, key: string, failure: string) {
		const [sliceId, role, head] = key.split(":");
		const slice = task.slices.find((s) => s.id === sliceId);
		if (!slice || slice.status !== "building" || slice.reviewHead !== head || slice.reviews.some((r) => r.head === head && r.reviewer === role)) return;
		if (failure.startsWith("cancelled")) return;
		const retries = (slice.reviewerRetries ??= {});
		if (!retries[`${role}:${head}`]) {
			retries[`${role}:${head}`] = 1;
			this.note(task, head, `${slice.id}: the ${role} reviewer failed (${failure.split("\n")[0].slice(0, 200)}); starting it again`);
			await this.schedule(task, { kind: "reviewer", slice: slice.id, role, head }, []);
			return;
		}
		this.flagHuman(task, slice, head, `The ${role} reviewer failed twice on ${short(head)}: ${failure.slice(0, 500)}`, `the ${role} reviewer failed twice`);
	}

	/**
	 * Merge-ahead. Called whenever a slice's fork may have moved. Records what the
	 * slice touched, flags paths outside its lane, and test-merges it against the
	 * base and every other slice that has pushed work. The check runs without the
	 * lock, on a snapshot; it is applied only if no other push was recorded
	 * meanwhile, and redone otherwise.
	 */
	async recordPush(sliceId: string) {
		for (let attempt = 1; ; attempt++) {
			// Check the push against a snapshot, without the lock: Merge-ahead clones
			// and test-merges, which takes seconds and grows with the number of changes.
			const snapshot = await this.load();
			const seen = this.buildingSlice(snapshot, sliceId);
			const before = seen.head;
			const head = await this.changeHead(snapshot, seen);
			if (!head || head === before) return { task: snapshot, checks: [] as MergeCheck[], changed: false };
			const checks = await mergeAhead(this.env.ARTIFACTS, snapshot, seen);

			// Apply it, if the change is still where the check found it.
			const applied = await this.exclusive(async () => {
				const task = await this.load();
				const slice = this.buildingSlice(task, sliceId);
				// Another report of the same push got here first.
				if (slice.head === seen.head) return { task, checks: [] as MergeCheck[], changed: false };
				// A different push was recorded meanwhile: this check may be stale.
				if (slice.head !== before) return null;
				slice.head = seen.head;
				slice.mergeBase = seen.mergeBase;
				slice.touched = seen.touched;
				slice.outOfLane = seen.outOfLane;
				this.renewLease(task, slice);
				await this.scheduleLeaseCheck(task);
				const conflicts = checks.filter((c) => c.status === "conflict");
				slice.pushes = [...(slice.pushes ?? []), { head: slice.head!, at: new Date().toISOString(), files: slice.touched.length, outOfLane: slice.outOfLane.length, conflicts: conflicts.length }].slice(-50);
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
			}, "push:apply");
			if (applied) return applied;
			if (attempt === 3) fail(409, `${sliceId} kept moving while its push was being checked; report the push again`);
		}
	}

	/** Pin the slice's current head as the commit under review. */
	private async pinForReview(task: Task, slice: Slice) {
		if (slice.status !== "building") fail(409, `slice ${slice.id} is ${slice.status}`);
		const head = await this.changeHead(task, slice);
		if (!head || head === (slice.startCommit ?? task.baseCommit)) fail(409, `slice ${slice.id} has no work to review`);
		slice.reviewHead = head;
		// The rules for this commit: the task's, made stricter for the paths it claims and touches.
		const { escalatedBy, ...policy } = effectivePolicy(task.review, changePaths(slice));
		slice.review = policy;
		slice.reviewRequestedAt = new Date().toISOString();
		if (escalatedBy.length) this.note(task, head, `${slice.id} touches ${escalatedBy.join(", ")}, so its review needs ${policy.reviewers.join(", ")}${policy.vetoes.length ? ` (${policy.vetoes.join(", ")} can veto)` : ""}`);
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
				this.flagHuman(
					task,
					slice,
					head,
					`Sent back, but the builder finished without new commits; it needs a decision outside its lane. Builder's explanation: ${buildSummary ?? "none given"}`,
					"sent back, but its builder finished without new commits",
				);
				await this.save(task);
				return { head, reviewers: [] as string[], failed: [] as string[], escalated: true };
			}
			this.note(task, head, `${slice.id} ready for review at ${short(head)}${buildSummary ? `: ${buildSummary}` : ""}`);
			await this.save(task);

			const policy = policyFor(task, slice);
			// Blueprint reviews its own roles; outside agents review the external ones (review_queue, submit_review).
			const reviewers = hostedRoles(policy);
			const external = policy.external ?? [];
			if (external.length) this.note(task, head, `${slice.id} waits for external review: ${external.join(", ")}`);
			const failed: string[] = [];
			for (const role of reviewers) await this.schedule(task, { kind: "reviewer", slice: slice.id, role, head }, failed);
			// Nothing to wait for (no approvals required, no veto role): straight to the checks.
			if (tally(policy, slice).status === "approved") await this.integrateOrGate(task, slice);
			// Look again if the external reviewers don't come.
			if (external.length) await this.scheduleLeaseCheck(task);
			await this.save(task);
			return { head, reviewers, external, failed, escalated: false };
		});
	}

	/** Quorum, step 2. Blueprint's own reviewer agent submits its verdict on the pinned head. */
	submitReview(sliceId: string, input: Omit<Review, "at" | "by">) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			const policy = policyFor(task, slice);
			if (!hostedRoles(policy).includes(input.reviewer)) fail(400, `${input.reviewer} is not a role Blueprint reviews here`);
			return this.recordReview(task, slice, { reviewer: input.reviewer, head: input.head, verdict: input.verdict, summary: input.summary, ...(input.evidence ? { evidence: input.evidence } : {}), ...(input.usage ? { usage: input.usage } : {}) });
		});
	}

	/**
	 * An outside agent's review, for one of the policy's external roles. `by` is
	 * who it is (a registered agent, or an Access identity): never the change's
	 * author, and one role per reviewer on a commit, so approvals come from
	 * different reviewers.
	 */
	submitExternalReview(sliceId: string, input: Omit<Review, "at" | "by" | "usage">, by: string) {
		return this.exclusive(async () => {
			const task = await this.load();
			const slice = this.slice(task, sliceId);
			const policy = policyFor(task, slice);
			// A person (signed in through Access) may review any role, from the dashboard; an agent only the external ones.
			const person = by.startsWith("person:");
			if (person && !policy.reviewers.includes(input.reviewer)) fail(400, `${input.reviewer} is not a reviewer role here (${policy.reviewers.join(", ") || "none"})`);
			if (!person && !(policy.external ?? []).includes(input.reviewer))
				fail(400, `${input.reviewer} is not a role outside agents review here${policy.external?.length ? ` (they review ${policy.external.join(", ")})` : ""}`);
			if (by === slice.authorBy)
				fail(403, `you opened ${slice.id}, so you can't review it${by.startsWith("agent:") ? "" : ": if you're a different agent sharing the author's access token, register your own agent (register_agent) and review with its key"}`);
			const other = slice.reviews.find((r) => r.head === input.head && r.by === by && r.reviewer !== input.reviewer);
			if (other) fail(409, `you already reviewed ${short(input.head)} as ${other.reviewer}: each reviewer counts for one role`);
			return this.recordReview(task, slice, { reviewer: input.reviewer, head: input.head, verdict: input.verdict, summary: input.summary, ...(input.evidence ? { evidence: input.evidence } : {}), by });
		});
	}

	/** Record a verdict on the pinned head, then merge, send back or wait, as the policy says. Caller holds the lock. */
	private async recordReview(task: Task, slice: Slice, input: Omit<Review, "at">) {
		const policy = policyFor(task, slice);
		if (input.verdict !== "approve" && input.verdict !== "reject") fail(400, "verdict must be approve or reject");
		if (typeof input.summary !== "string" || !input.summary.trim()) fail(400, "a review needs a summary");
		if (!slice.reviewHead || input.head !== slice.reviewHead)
			fail(409, `review is for ${input.head}, but the head under review is ${slice.reviewHead ?? "none"}`);

		slice.reviews.push({ ...input, at: new Date().toISOString() });
		const quorum = tally(policy, slice);
		this.note(task, input.head, `${slice.id}: ${input.reviewer} reviewer ${input.verdict === "approve" ? "approved" : "rejected"}: ${input.summary}`);
		if (quorum.status !== "pending") this.note(task, input.head, `${slice.id}: quorum ${quorum.status}`);
		if (slice.status === "integrated" && input.verdict === "reject") {
			const finding = `Late rejection from ${input.reviewer} after integration: ${input.summary}${input.evidence ? `\nEvidence: ${input.evidence}` : ""}`;
			this.flagHuman(task, slice, input.head, [slice.attention, finding].filter(Boolean).join("\n"), finding);
		}
		await this.save(task);
		// Keep valid late votes for the pinned head, but integration is final:
		// never send an already integrated slice back or integrate it again.
		if (slice.status === "integrated") return { task, quorum, next: "wait" as const };

		// Auto-integrate an approved slice; send a rejected one back to its builder.
		const step = nextStep(policy, slice);
		try {
			if (step === "integrate") {
				await this.integrateOrGate(task, slice);
			} else if (step === "send-back") {
				await this.sendBack(task, slice, reviewFeedback(policy, slice));
			}
		} catch (err) {
			slice.attention = `${step} failed: ${statusOf(err).message}`;
		}
		await this.save(task);
		return { task, quorum, next: step };
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
		// Look again if no result comes (see restartStalledGates).
		await this.scheduleLeaseCheck(task);
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
		await this.scheduleLeaseCheck(task);
	}

	/**
	 * The gate asks for its plan when a run starts, so it checks against the base
	 * as it is then, with the exclusions and tokens of that moment. Null when the
	 * commits are no longer the ones waiting to integrate.
	 */
	gatePlan(sliceId: string, head: string, group: { slice: string; head: string }[] = []) {
		return this.exclusive(async (): Promise<GatePlan | null> => {
			const task = await this.load();
			const members = gateMembers(task, sliceId, head, group);
			if (!members) return null;
			const [lead, ...others] = members;
			const baseHead = (await headOf(this.env.ARTIFACTS, task.baseRepo!, projectBranch(task)))!;
			const exclude = gateExclusions(task.slices, members.map((m) => m.id));
			const base = await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "read", 3600);
			const forks = await Promise.all(members.map((m) => remoteFor(this.env.ARTIFACTS, m.repo!, "read", 3600)));
			const at = new Date().toISOString();
			for (const m of members) m.gate = { ...m.gate!, status: "running", baseHead, at, excluded: exclude };
			await this.save(task);
			return {
				baseHead,
				branch: projectBranch(task),
				base: { remote: base.url, token: base.token },
				fork: { remote: forks[0].url, token: forks[0].token, ref: changeRef(task, lead) },
				others: others.map((o, i) => ({ slice: o.id, head: o.reviewHead!, remote: forks[i + 1].url, token: forks[i + 1].token, ref: changeRef(task, o) })),
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
			const members = gateMembers(task, sliceId, result.head, group);
			if (!members) return { outcome: "stale" as const };
			const [slice, ...others] = members;
			const baseHead = await headOf(this.env.ARTIFACTS, task.baseRepo!, projectBranch(task));
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
				} else if (!result.mergeConflict && othersCanStillIntegrate(task, slice)) {
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
				this.flagHuman(task, slice, slice.reviewHead, `after the gate: ${statusOf(err).message}`);
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
		return this.mutate(async (task) => {
			const slice = this.buildingSlice(task, sliceId);
			const quorum = tally(policyFor(task, slice), slice);
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
			const slice = this.buildingSlice(task, sliceId);
			if (!slice.reviewHead) fail(409, `slice ${sliceId} has no commit under review`);
			const builder = await this.env.BUILDER.getByName(agentsOf(task, slice)).state();
			if (builder && (builder.status === "queued" || builder.status === "working")) fail(409, "the slice's builder is still working");
			const head = await this.changeHead(task, slice);
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
			if (await this.autoParkWaitingBuilder(task, slice)) {
				slice.attention = undefined;
				await this.save(task);
				return;
			}
			this.flagHuman(task, slice, slice.head, message);
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
			const slice = this.buildingSlice(task, sliceId);
			const text = `Message from a human on the team: ${message}`;
			const eventId = `human-message:${crypto.randomUUID()}`;
			const delivery = await this.wakeBuilder(task, slice, eventId, text);
			const delivered: "inbox" | "resumed" = delivery === "resumed" ? "resumed" : "inbox";
			slice.attention = undefined;
			this.note(task, slice.head, `Message from ${accessIdentityLabel(actor)} to ${slice.id}'s builder (${delivered === "inbox" ? "delivered" : "resumed it"}): ${message}`);
			await this.save(task);
			return { delivered };
		});
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
			const head = await this.changeHead(task, slice);
			if (head !== slice.reviewHead) fail(409, `${slice.id} moved to ${head} after review of ${slice.reviewHead}`);
			if (slice.outOfLane.length) fail(409, `${slice.id} changed paths outside its lane: ${slice.outOfLane.join(", ")}`);
		}
		const ws = await Workspace.clone(await remoteFor(this.env.ARTIFACTS, task.baseRepo!, "write"), projectBranch(task));
		for (const slice of slices) {
			await ws.fetch(slice.id, await remoteFor(this.env.ARTIFACTS, slice.repo!), changeRef(task, slice));
			try {
				await ws.merge(`refs/remotes/${slice.id}/${changeRef(task, slice)}`, `Integrate ${slice.id}: ${slice.title}`);
			} catch (err) {
				if (err instanceof git.Errors.MergeConflictError) return { ok: false, slice, files: err.data.filepaths };
				throw err;
			}
		}
		await ws.push();

		for (const slice of slices) {
			slice.status = "integrated";
			slice.endedAt = new Date().toISOString();
			slice.attention = undefined;
			this.note(task, slice.reviewHead, `${slice.id} merged into ${projectBranch(task)}${slices.length > 1 ? `, together with ${slices.filter((s) => s !== slice).map((s) => s.id).join(", ")}` : ""}`);
		}
		const integratedHead = await headOf(this.env.ARTIFACTS, task.baseRepo!, projectBranch(task));
		for (const request of task.laneChangeRequests ?? []) {
			if (!slices.some((slice) => slice.id === request.owner) || (request.status !== "pending" && request.status !== "answered")) continue;
			let included = false;
			if (request.status === "answered" && request.answerCommit && integratedHead) {
				try {
					included = (await ws.mergeBase(request.answerCommit, integratedHead)) === request.answerCommit;
				} catch (err) {
					// Not provably included: the request goes to a human below.
					console.error(`checking whether ${request.answerCommit} is integrated, for cross-lane request ${request.id}, failed: ${statusOf(err).message}`, err);
					included = false;
				}
			}
			if (included) {
				request.status = "integrated";
				request.integratedAt = new Date().toISOString();
				this.note(task, request.answerCommit, `Cross-lane request ${request.id} from ${request.requester} fulfilled by slice ${request.owner}; change commit ${request.answerCommit} is integrated`);
				const message = `Cross-lane request ${request.id} was integrated with owner slice ${request.owner} at commit ${request.answerCommit}. Call fetch_base and merge what it fetched to get it, then re-run your tests.`;
				await this.wakeLaneRequester(task, request, message);
			} else {
				const message = `Owner slice ${request.owner} integrated without the answered change commit for cross-lane request ${request.id} (${request.path}). The owner can no longer change its lane; this request needs a human.`;
				await this.flagLaneRequest(task, request, message, true);
				this.note(task, integratedHead, `Cross-lane request ${request.id} from ${request.requester} not fulfilled when owner ${request.owner} integrated; request needs a human`);
			}
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
			this.flagHuman(task, slice, slice.reviewHead, `Sent back ${MAX_REVISIONS} times without passing review; needs a human. Last feedback:\n${message}`, `sent back ${MAX_REVISIONS} times without passing`);
			return;
		}
		slice.revisions = (slice.revisions ?? 0) + 1;
		this.note(task, slice.reviewHead, `${slice.id} sent back to its builder (revision ${slice.revisions} of ${MAX_REVISIONS}):\n${clipText(message, 1_500)}`);
		task.queue = task.queue.filter((item) => !(item.kind === "reviewer" && item.slice === slice.id));
		await Promise.allSettled(this.cancelReviewers(agentsOf(task, slice), hostedRoles(policyFor(task, slice)), head, "the slice was sent back to its builder"));
		// An external agent reads the findings from its inbox; there is no hosted builder to resume.
		if (slice.external) {
			this.toInbox(slice, message);
			return;
		}
		await this.env.BUILDER.getByName(agentsOf(task, slice)).revise(message, await this.resumeCredentials(task, slice));
		// A revision runs right away, outside the queue: the slice is blocking integration.
		if (!task.active.builders.includes(slice.id)) task.active.builders.push(slice.id);
	}

}
