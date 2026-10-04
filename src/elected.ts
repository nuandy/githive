import { remoteFor, sliceRepoName } from "./artifacts";
import { GitCasLog } from "./election-git";
import type { AccessIdentity } from "./access-contract";
import type { Coordinator } from "./coordinator";
import { statusOf } from "./errors";
import type { LaneChangeAnswer, LaneChangeRequestInput } from "./lane-change-contract";
import { changeId, claimsOf } from "./open-mode";
import type { Peer } from "./peer";
import type { Task } from "./types";

// The Worker's side of the elected coordinator. The Worker keeps no state: it
// asks a change's own peer who leads, and calls the leader. A new change's peer
// is named before the change exists (the Worker picks its id). Reads need no
// leader: they come from the log's state in Git.

type PeerStub = Pick<
	Peer,
	| "lead"
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
	/** The task as the log's tip records it, or null if the log has no task. */
	readTask: () => Promise<Task | null>;
}

const NOT_LEADING = /no longer leading/;

/** The open task's decisions, made by whichever peer leads, in place of a fixed Coordinator. */
export function electedCoordinator(ctx: ElectedContext) {
	/** Call the leader, asking `asker` (a change's peer) who it is; ask afresh once if the answer was stale. */
	async function viaLeader<T>(asker: string, call: (leader: PeerStub) => Promise<T>): Promise<T> {
		for (let fresh = false; ; fresh = true) {
			const { leader } = await ctx.peer(asker).lead(ctx.taskId, ctx.repo, asker, fresh);
			try {
				return await call(ctx.peer(leader));
			} catch (err) {
				if (fresh || !NOT_LEADING.test(statusOf(err).message)) throw err;
			}
		}
	}
	const peerOf = (change: string) => sliceRepoName(ctx.taskId, change);
	const read = async () => (await ctx.readTask()) ?? (() => {
		throw new Error(`[404] no task ${ctx.taskId}`);
	})();

	return {
		state: read,
		claims: async () => claimsOf(await read()),
		openChange: (input: { title: string; intent: string; owns: string[]; hosted?: boolean }, actor?: AccessIdentity) => {
			const id = changeId(typeof input?.title === "string" ? input.title : "change");
			return viaLeader(peerOf(id), (leader) => leader.openChange({ ...input, id }, actor));
		},
		extendClaim: (change: string, paths: string[]) => viaLeader(peerOf(change), (leader) => leader.extendClaim(change, paths)),
		abandonChange: (change: string, reason: string, actor?: AccessIdentity) => viaLeader(peerOf(change), (leader) => leader.abandonChange(change, reason, actor)),
		recordPush: (change: string) => viaLeader(peerOf(change), (leader) => leader.recordPush(change)),
		startReviewers: (change: string, summary?: string) => viaLeader(peerOf(change), (leader) => leader.startReviewers(change, summary)),
		readInbox: (change: string, since?: string) => viaLeader(peerOf(change), (leader) => leader.readInbox(change, since)),
		requestLaneChange: (change: string, input: LaneChangeRequestInput) => viaLeader(peerOf(change), (leader) => leader.requestLaneChange(change, input)),
		answerLaneChange: (change: string, requestId: string, answer: LaneChangeAnswer) => viaLeader(peerOf(change), (leader) => leader.answerLaneChange(change, requestId, answer)),
		externalCredentials: (change: string) => viaLeader(peerOf(change), (leader) => leader.externalCredentials(change)),
	} satisfies Partial<Record<keyof Coordinator, unknown>>;
}

/** The elected coordinator of an open task, wired to the Worker's bindings: peers are Peer objects, the log is in Git. */
export function electedForEnv(env: Env, taskId: string, repo: string) {
	return electedCoordinator({
		taskId,
		repo,
		peer: (name) => env.PEER.getByName(name) as unknown as PeerStub,
		readTask: async () => (await new GitCasLog<Task>(() => remoteFor(env.ARTIFACTS, repo, "read"), taskId).read())?.commit.state ?? null,
	});
}
