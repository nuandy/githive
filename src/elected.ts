import { sliceRepoName } from "./artifacts";
import type { AccessIdentity } from "./access-contract";
import type { Coordinator } from "./coordinator";
import { statusOf } from "./errors";
import type { LaneChangeAnswer, LaneChangeRequestInput } from "./lane-change-contract";
import { changeId, claimsOf } from "./open-mode";
import type { Peer } from "./peer";
import type { Task } from "./types";

// The Worker's side of the elected coordinator. The Worker keeps no state: it
// asks a change's own peer who leads, and calls the leader. Task-level reads,
// and the question of who leads when a change is opened, go to the task's
// reader: a peer that only reads (it never campaigns or decides) and, being a
// Durable Object, keeps its copy of the log warm.

type PeerStub = Pick<
	Peer,
	| "lead"
	| "peek"
	| "whoLeads"
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
	const readerName = peerOf("reader");
	const reader = () => ctx.peer(readerName);
	const read = (): Promise<Task> => reader().peek(ctx.taskId, ctx.repo, readerName);

	/**
	 * Call the leader the reader knows of (it usually does, and stays warm); if
	 * none, or that peer no longer leads, go through `asker`, the change's own
	 * peer, which campaigns if nobody leads.
	 */
	async function onLeader<T>(asker: string, call: (leader: PeerStub) => Promise<T>): Promise<T> {
		const known = await reader().whoLeads(ctx.taskId, ctx.repo, readerName);
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

/** The elected coordinator of an open task, wired to the Worker's bindings: peers are Peer objects. */
export function electedForEnv(env: Env, taskId: string, repo: string) {
	return electedCoordinator({ taskId, repo, peer: (name) => env.PEER.getByName(name) as unknown as PeerStub });
}
