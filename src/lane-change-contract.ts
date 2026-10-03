import type { Task } from "./types";

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
}

export type LaneChangeRequestResult =
	| { outcome: "requested"; request: LaneChangeRequest; delivery: "inbox" | "resumed"; message: string }
	| { outcome: "human"; request: LaneChangeRequest; message: string }
	| { outcome: "no-owner"; message: string };

/** The Coordinator RPC seam used by builders. */
export interface LaneChangeCoordinator {
	requestLaneChange(requesterSliceId: string, input: LaneChangeRequestInput): Promise<LaneChangeRequestResult>;
	answerLaneChange(ownerSliceId: string, requestId: string, answer: LaneChangeAnswer): Promise<LaneChangeRequest>;
}

declare module "./types" {
	interface Task {
		laneChangeRequests?: LaneChangeRequest[];
	}
}

declare module "./coordinator" {
	interface Coordinator extends LaneChangeCoordinator {}
}

// Keep the imported Task in this module so the augmentation is checked against
// the public task interface when the contract is type-checked.
void (null as unknown as Task | null);
