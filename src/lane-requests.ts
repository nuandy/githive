import type { LaneChangeRequest } from "./lane-change-contract";
import type { Task } from "./types";

// Pure parts of cross-lane requests. The Coordinator delivers them.

/** A slice's own requests that are still waiting: pending, or answered but not yet integrated. */
export const unresolvedRequests = (task: Task, sliceId: string): LaneChangeRequest[] =>
	(task.laneChangeRequests ?? []).filter((request) => request.requester === sliceId && (request.status === "pending" || request.status === "answered"));
