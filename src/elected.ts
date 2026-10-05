import { remoteFor, sliceRepoName } from "./artifacts";
import { GitCasLog } from "./election-git";
import type { AccessIdentity } from "./access-contract";
import type { Coordinator } from "./coordinator";
import { statusOf } from "./errors";
import type { LaneChangeAnswer, LaneChangeRequestInput } from "./lane-change-contract";
import { changeId, claimsOf } from "./open-mode";
import type { Peer } from "./peer";
import type { Task } from "./types";

// The Worker's side of the elected coordinator. The Worker keeps no state. The
// task index (which it reads on every request anyway) notes who leads, as the
// leader last reported it: the Worker calls that peer directly, for decisions
// and reads. The note is only a hint. If it is stale, or nobody leads, a
// decision goes through the change's own peer, which looks in Git and
// campaigns if need be; a read with nobody leading comes from Git.

type PeerStub = Pick<
	Peer,
	| "lead"
	| "peek"
	| "openChange"
	| "extendClaim"
	| "abandonChange"
	| "recordPush"
	| "startReviewers"
	| "readInbox"
	| "requestLaneChange"
	| "answerLaneChange"
	| "externalCredentials"
	| "submitReview"
	| "submitExternalReview"
	| "registerAgent"
	| "agentStopped"
	| "flagSlice"
	| "parkBuilder"
	| "parkedBuilderTimedOut"
	| "gatePlan"
	| "gateResult"
	| "sliceDiff"
	| "waive"
	| "messageBuilder"
	| "retryGate"
>;

export interface ElectedContext {
	taskId: string;
	repo: string;
	/** The Peer Durable Object with this name. */
	peer: (name: string) => PeerStub;
	/** Who leads, as the task index notes it (null or absent: nobody, as far as it knows). */
	hint?: string | null;
	/** The task from Git, for reads when nobody leads. */
	readLog: () => Promise<Task | null>;
	/** How to wait between tries while a leader is unavailable (default: a timer). */
	wait?: (ms: number) => Promise<void>;
	/** How long to keep trying while a leader is unavailable, before giving up (default: two leases). */
	patienceMs?: number;
}

const NOT_LEADING = /no longer leading/;

/** A peer that can't be reached: crashed (simulated, for failover tests), reset, or its connection lost. */
const isUnavailable = (err: unknown) => /peer unavailable|network connection lost|durable object reset|code was updated|overloaded/i.test(statusOf(err).message);

/** Between tries while a leader is unavailable. */
const RETRY_MS = 1_000;

/** The open task's decisions, made by whichever peer leads, in place of a fixed Coordinator. */
export function electedCoordinator(ctx: ElectedContext) {
	const wait = ctx.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const patience = ctx.patienceMs ?? 60_000;
	/** A peer of no change, for asking who leads when the change's own peer is the one that's down. */
	const standby = `${ctx.taskId}--standby`;

	/**
	 * Call the leader, asking `asker` (a change's peer) who it is; ask afresh if
	 * the answer was stale. While the leader is unavailable (crashed, or its
	 * object reset), keep asking: once its lease runs out the asker campaigns and
	 * leads, so decisions pause for at most a lease rather than fail. If the
	 * asker itself is down, a standby peer asks instead.
	 */
	async function viaLeader<T>(asker: string, call: (leader: PeerStub) => Promise<T>, startFresh = false): Promise<T> {
		const deadline = Date.now() + patience;
		let who = asker;
		for (let fresh = startFresh; ; fresh = true) {
			let leader: string;
			try {
				({ leader } = await ctx.peer(who).lead(ctx.taskId, ctx.repo, who, fresh));
			} catch (err) {
				if (!isUnavailable(err) || who === standby) throw err;
				who = standby;
				continue;
			}
			try {
				return await call(ctx.peer(leader));
			} catch (err) {
				// A stale answer: look afresh once, at once.
				if (!fresh && NOT_LEADING.test(statusOf(err).message)) continue;
				if (!isUnavailable(err) && !NOT_LEADING.test(statusOf(err).message)) throw err;
				if (Date.now() >= deadline) throw err;
				await wait(RETRY_MS);
			}
		}
	}
	const peerOf = (change: string) => sliceRepoName(ctx.taskId, change);
	/** The task as committed: from the leader's memory (a peer that no longer leads reads its own copy of the log), or from Git if nobody leads. */
	const read = async (): Promise<Task> =>
		(ctx.hint
			? // A leader that can't be reached: what's committed is in Git.
				await ctx.peer(ctx.hint).peek(ctx.taskId, ctx.repo, ctx.hint).catch((err) => (isUnavailable(err) ? ctx.readLog() : Promise.reject(err)))
			: await ctx.readLog()) ??
		(() => {
			throw new Error(`[404] no task ${ctx.taskId}`);
		})();

	/**
	 * Call the leader the task index names; if none, or that peer no longer
	 * leads, go through `asker`, the change's own peer, which looks in Git and
	 * campaigns if nobody leads.
	 */
	async function onLeader<T>(asker: string, call: (leader: PeerStub) => Promise<T>): Promise<T> {
		const known = ctx.hint;
		if (!known) return viaLeader(asker, call);
		try {
			return await call(ctx.peer(known));
		} catch (err) {
			if (!NOT_LEADING.test(statusOf(err).message) && !isUnavailable(err)) throw err;
			return viaLeader(asker, call, true);
		}
	}

	return {
		state: read,
		claims: async () => claimsOf(await read()),
		openChange: async (input: { title: string; intent: string; owns: string[]; hosted?: boolean; agent?: string; authorAgent?: string }, actor?: AccessIdentity) => {
			const id = changeId(typeof input?.title === "string" ? input.title : "change");
			return onLeader(peerOf(id), (leader) => leader.openChange({ ...input, id }, actor));
		},
		extendClaim: (change: string, paths: string[]) => onLeader(peerOf(change), (leader) => leader.extendClaim(change, paths)),
		abandonChange: (change: string, reason: string, actor?: AccessIdentity) => onLeader(peerOf(change), (leader) => leader.abandonChange(change, reason, actor)),
		recordPush: (change: string) => onLeader(peerOf(change), (leader) => leader.recordPush(change)),
		startReviewers: (change: string, summary?: string) => onLeader(peerOf(change), (leader) => leader.startReviewers(change, summary)),
		readInbox: (change: string, since?: string) => onLeader(peerOf(change), (leader) => leader.readInbox(change, since)),
		requestLaneChange: (change: string, input: LaneChangeRequestInput) => onLeader(peerOf(change), (leader) => leader.requestLaneChange(change, input)),
		answerLaneChange: (change: string, requestId: string, answer: LaneChangeAnswer) => onLeader(peerOf(change), (leader) => leader.answerLaneChange(change, requestId, answer)),
		externalCredentials: (change: string) => onLeader(peerOf(change), (leader) => leader.externalCredentials(change)),
		// Outside agents: registering is the task's, so it asks through a peer of its own.
		registerAgent: (name: string, keyHash: string, currentKeyHash?: string, actor?: AccessIdentity) => onLeader(peerOf("agents"), (leader) => leader.registerAgent(name, keyHash, currentKeyHash, actor)),
		submitExternalReview: (change: string, review: Parameters<Coordinator["submitExternalReview"]>[1], by: string) => onLeader(peerOf(change), (leader) => leader.submitExternalReview(change, review, by)),
		// Blueprint's own workers report here too: hosted reviewers and builders, and the gate.
		submitReview: (change: string, review: Parameters<Coordinator["submitReview"]>[1]) => onLeader(peerOf(change), (leader) => leader.submitReview(change, review)),
		/** A builder stops as its change; a reviewer as `change:role:head`. */
		agentStopped: (kind: Parameters<Coordinator["agentStopped"]>[0], key: string, failure?: string) => onLeader(peerOf(key.split(":")[0]), (leader) => leader.agentStopped(kind, key, failure)),
		flagSlice: (change: string, message: string) => onLeader(peerOf(change), (leader) => leader.flagSlice(change, message)),
		parkBuilder: (change: string) => onLeader(peerOf(change), (leader) => leader.parkBuilder(change)),
		parkedBuilderTimedOut: (change: string, parkedAt: string) => onLeader(peerOf(change), (leader) => leader.parkedBuilderTimedOut(change, parkedAt)),
		gatePlan: (change: string, head: string, group?: Parameters<Coordinator["gatePlan"]>[2]) => onLeader(peerOf(change), (leader) => leader.gatePlan(change, head, group)),
		gateResult: (change: string, result: Parameters<Coordinator["gateResult"]>[1], excluded: string[], group?: Parameters<Coordinator["gateResult"]>[3]) =>
			onLeader(peerOf(change), (leader) => leader.gateResult(change, result, excluded, group)),
		// A person's controls, from the dashboard.
		sliceDiff: (change: string) => onLeader(peerOf(change), (leader) => leader.sliceDiff(change)),
		waive: (change: string, input: { reason: string }, actor: AccessIdentity) => onLeader(peerOf(change), (leader) => leader.waive(change, input, actor)),
		messageBuilder: (change: string, message: string, actor: AccessIdentity) => onLeader(peerOf(change), (leader) => leader.messageBuilder(change, message, actor)),
		retryGate: (change: string, actor: AccessIdentity) => onLeader(peerOf(change), (leader) => leader.retryGate(change, actor)),
	} satisfies Partial<Record<keyof Coordinator, unknown>>;
}

/** The elected coordinator of an open task, wired to the Worker's bindings: peers are Peer objects, the log is in Git. */
export function electedForEnv(env: Env, taskId: string, repo: string, hint?: string | null) {
	return electedCoordinator({
		taskId,
		repo,
		hint,
		peer: (name) => env.PEER.getByName(name) as unknown as PeerStub,
		readLog: async () => (await new GitCasLog<Task>(() => remoteFor(env.ARTIFACTS, repo, "read"), taskId).read())?.commit.state ?? null,
	});
}

const fixedCoordinator = (env: Env, taskId: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(taskId));

/**
 * The coordinator of a task, for anyone reporting to it (the Worker, and
 * Blueprint's builders, reviewers and gate): the elected coordinator for an
 * open task (its peers and its log in Git), or the task's Coordinator object
 * for a planned one. Resolved from the task index on first use, so callers use
 * it like a Coordinator stub.
 */
export function taskCoordinator(env: Env, taskId: string) {
	const resolved = (async () => {
		const ref = await env.TASK_INDEX.getByName("all").get(taskId);
		return ref?.elected ? electedForEnv(env, taskId, ref.repo, ref.leader?.name) : fixedCoordinator(env, taskId);
	})();
	return new Proxy({} as ReturnType<typeof fixedCoordinator>, {
		get: (_target, method: string) =>
			// Not a promise itself: `await taskCoordinator(...)` must not look for `then`.
			method === "then"
				? undefined
				: async (...args: unknown[]) => {
						const target = (await resolved) as unknown as Record<string, (...a: unknown[]) => unknown>;
						if (typeof target[method] !== "function") throw new Error(`[409] tasks run by the elected coordinator don't support ${method}`);
						return target[method](...args);
					},
	});
}
