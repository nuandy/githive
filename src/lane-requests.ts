import type { LaneChangeRequest } from "./lane-change-contract";
import { isPlainPath } from "./paths";
import type { Task } from "./types";

// Pure parts of cross-lane requests. The Coordinator delivers them.

/** A slice's own requests that are still waiting: pending, or answered but not yet integrated. */
export const unresolvedRequests = (task: Task, sliceId: string): LaneChangeRequest[] =>
	(task.laneChangeRequests ?? []).filter((request) => request.requester === sliceId && (request.status === "pending" || request.status === "answered"));

/**
 * Whether a request from `requester` to `owner` would close a wait cycle: the
 * owner already waits, directly or through others, on the requester. Pending
 * and answered requests both wait.
 */
export function closesLaneRequestCycle(task: Task, requester: string, owner: string) {
	const graph = new Map<string, string[]>();
	for (const request of task.laneChangeRequests ?? []) {
		if (request.status !== "pending" && request.status !== "answered") continue;
		graph.set(request.requester, [...(graph.get(request.requester) ?? []), request.owner]);
	}
	const seen = new Set<string>();
	const pending = [owner];
	while (pending.length) {
		const current = pending.pop()!;
		if (current === requester) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		pending.push(...(graph.get(current) ?? []));
	}
	return false;
}

/** A plain path that is also safe to repeat to other agents: no surrounding space, drive letters, backslashes or control characters. */
export function safeLanePath(path: string) {
	return isPlainPath(path) && path === path.trim() && !/[A-Za-z]:/.test(path) && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path);
}

/** What the owning slice's agent is told about a request. */
export function laneRequestMessage(request: LaneChangeRequest) {
	return `Cross-lane change request ${request.id} from slice ${request.requester}. Path: ${request.path}. Need: ${request.need}. Reason: ${request.reason}`;
}

/** A slice's requests that are settled (integrated, declined or handed to a human), each with what its builder should do. */
export function latestResolutions(task: Task, sliceId: string) {
	return (task.laneChangeRequests ?? [])
		.filter((request) => request.requester === sliceId && request.status !== "pending" && request.status !== "answered")
		.map((request) => ({
			requestId: request.id,
			status: request.status,
			message: request.status === "integrated"
				? `Request ${request.id} was integrated. Fetch and merge base/main.`
				: request.status === "declined"
					? `Request ${request.id} was declined: ${request.answer ?? "no reason provided"}`
					: `Request ${request.id} needs a human: ${task.slices.find((s) => s.id === sliceId)?.attention ?? "the request was handed off"}`,
		}));
}
