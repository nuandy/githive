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
}

const NOT_LEADING = /no longer leading/;

/** The open task's decisions, made by whichever peer leads, in place of a fixed Coordinator. */
export function electedCoordinator(ctx: ElectedContext) {
	/** Call the leader, asking `asker` (a change's peer) who it is; ask afresh once if the answer was stale. */
	async function viaLeader<T>(asker: string, call: (leader: PeerStub) => Promise<T>, startFresh = false): Promise<T> {
		for (let fresh = startFresh; ; fresh = true) {
			const { leader } = await ctx.peer(asker).lead(ctx.taskId, ctx.repo, asker, fresh);
			try {
				return await call(ctx.peer(leader));
			} catch (err) {
				if (fresh || !NOT_LEADING.test(statusOf(err).message)) throw err;
			}
		}
	}
	const peerOf = (change: string) => sliceRepoName(ctx.taskId, change);
	/** The task as committed: from the leader's memory (a peer that no longer leads reads its own copy of the log), or from Git if nobody leads. */
	const read = async (): Promise<Task> =>
		(ctx.hint ? await ctx.peer(ctx.hint).peek(ctx.taskId, ctx.repo, ctx.hint) : await ctx.readLog()) ??
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
			if (!NOT_LEADING.test(statusOf(err).message)) throw err;
			return viaLeader(asker, call, true);
		}
	}

	return {
		state: read,
		claims: async () => claimsOf(await read()),
		openChange: async (input: { title: string; intent: string; owns: string[]; hosted?: boolean }, actor?: AccessIdentity) => {
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
