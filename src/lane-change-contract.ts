import type { ParkBuilderResult } from "./parking-contract";

/** A builder's request that the slice owning a path make a change in its lane. */
export interface LaneChangeRequest {
	id: string;
	requester: string;
	owner: string;
	path: string;
	need: string;
	reason: string;
	status: "pending" | "answered" | "declined" | "integrated" | "human";
	createdAt: string;
	answer?: string;
	answerCommit?: string;
	answeredAt?: string;
	integratedAt?: string;
}

export interface LaneChangeRequestInput {
	path: string;
	need: string;
	reason: string;
}

export interface LaneChangeAnswer {
	/** `done` means the owner made the requested change; `declined` is a final refusal. */
	outcome: "done" | "declined";
	/** The owner's explanation, delivered to the requester when declined. */
	answer: string;
	/** Commit containing the requested change; required to verify an integration. */
	commit?: string;
}

export type LaneChangeRequestResult =
	| { outcome: "requested"; request: LaneChangeRequest; delivery: "inbox" | "resumed"; message: string }
	| { outcome: "human"; request: LaneChangeRequest; message: string }
	| { outcome: "no-owner"; message: string };

/** The Coordinator RPC seam used by builders. */
export interface LaneChangeCoordinator {
	requestLaneChange(requesterSliceId: string, input: LaneChangeRequestInput): Promise<LaneChangeRequestResult>;
	answerLaneChange(ownerSliceId: string, requestId: string, answer: LaneChangeAnswer): Promise<LaneChangeRequest>;
	parkBuilder(sliceId: string): Promise<ParkBuilderResult>;
	parkedBuilderTimedOut(sliceId: string, parkedAt: string): Promise<void>;
}
