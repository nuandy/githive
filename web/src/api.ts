import type { Task } from "../../src/types";
import type { LaneChangeRequest } from "../../src/lane-change-contract";

export type { Task };
import type { Summaries } from "./lib/repos";

/** Unified, read-only Git diff pinned to the commits used to generate it. */
export interface UnifiedCodeDiff {
	base: string;
	head: string;
	unified: string;
	/** Every path whose tree entry changed, including paths whose diff text was capped. */
	files: string[];
	/** Changed paths whose diff content was omitted by per-file or total output limits. */
	omitted: string[];
}

/** One decision in a repo's log in Git (GET /tasks/:id/history), oldest first. */
export interface HistoryEntry {
	at: string;
	text: string;
	commit: string;
}

/** Accept { entries: [...] } (or a bare list), dropping malformed entries. */
export function normalizeHistory(value: unknown): HistoryEntry[] {
	const record = asRecord(value);
	const list = Array.isArray(value) ? value : asArray<unknown>(record?.entries);
	return list.flatMap((item) => {
		const entry = asRecord(item);
		if (!entry || typeof entry.text !== "string") return [];
		return [{ at: typeof entry.at === "string" ? entry.at : "", text: entry.text, commit: typeof entry.commit === "string" ? entry.commit : "" }];
	});
}

/** A repo in coordinator-free mode, as the dashboard shows it (GET /free/:repo; see src/free/mcp.ts). */
export interface FreeSnapshot {
	repo: string;
	policy: { required: number; vetoes: string[] };
	verify: string[];
	/** Whether records and merges are stamped with verified identity. */
	verified: boolean;
	claims: {
		change: string;
		agent: string;
		paths: string[];
		intent: string;
		since: string;
		active: string;
		by?: string;
		/** The change's branch head, null until something is pushed. */
		head: string | null;
		approval: { approved: boolean; approvals: number; required: number; vetoedBy: string[]; /** Veto roles that haven't approved yet (newer servers); a change merges only once each has. */ awaiting?: string[] };
		/** Blueprint's hosted agents on the change. */
		hosted?: { builder?: { status: string; revisions: number; error?: string }; reviewers: { role: string; status: string; verdict?: string }[] };
	}[];
	votes: { commit: string; reviewer: string; role: string; verdict: "approve" | "reject"; evidence: string; at: string; by?: string }[];
	/** Loaded apart (GET /free/:repo/audit): it replays every record, so it comes slower and less often. */
	audit?: FreeAudit;
}

export interface FreeAudit {
	merges: number;
	open: number;
	violations: { commit: string; author: string; rule: string; detail: string; by?: string; resolvedBy?: string }[];
}
export type Slice = Task["slices"][number];

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

/** A builder's or reviewer's public state (see src/sandbox.ts). */
export interface AgentState {
	status: "queued" | "working" | "parked" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	turns: number;
	toolCalls: number;
	usage: Usage;
	error?: string;
	log: { at: string; event: string }[];
	// Builders
	pushes?: number;
	revisions?: number;
	summary?: string;
	/** Time at which a builder entered its durable parked state. */
	parkedAt?: string;
	/** IDs of the cross-lane requests a parked builder is waiting for (the dashboard shows them from the task's requests). */
	waitingRequestIds?: string[];
	// Reviewers
	verdict?: "approve" | "reject";
	evidence?: string;
	quorum?: string;
}

export interface Live {
	task: Task;
	agents: { id: string; builder: AgentState | null; reviewers: { role: string; state: AgentState | null }[] }[];
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as RecordValue
		: null;
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function asStringArray(value: unknown): string[] {
	return asArray<unknown>(value).filter((item): item is string => typeof item === "string");
}

function normalizeReviewPolicy(value: unknown): Task["review"] {
	const policy = asRecord(value);
	return {
		...(policy ?? {}),
		reviewers: asStringArray(policy?.reviewers),
		required: typeof policy?.required === "number" ? policy.required : 0,
		vetoes: asStringArray(policy?.vetoes),
	} as Task["review"];
}

const laneChangeRequestStatuses: readonly LaneChangeRequest["status"][] = ["pending", "answered", "declined", "integrated", "human"];

function normalizeLaneChangeRequest(value: unknown): LaneChangeRequest | null {
	const request = asRecord(value);
	if (!request
		|| typeof request.id !== "string"
		|| typeof request.requester !== "string"
		|| typeof request.owner !== "string"
		|| typeof request.path !== "string"
		|| typeof request.need !== "string"
		|| typeof request.reason !== "string"
		|| typeof request.createdAt !== "string"
		|| !laneChangeRequestStatuses.includes(request.status as LaneChangeRequest["status"])) return null;
	return {
		id: request.id,
		requester: request.requester,
		owner: request.owner,
		path: request.path,
		need: request.need,
		reason: request.reason,
		status: request.status as LaneChangeRequest["status"],
		createdAt: request.createdAt,
		...(typeof request.answer === "string" ? { answer: request.answer } : {}),
		...(typeof request.answerCommit === "string" ? { answerCommit: request.answerCommit } : {}),
		...(typeof request.answeredAt === "string" ? { answeredAt: request.answeredAt } : {}),
		...(typeof request.integratedAt === "string" ? { integratedAt: request.integratedAt } : {}),
	};
}

function normalizeSlice(value: unknown): Slice | null {
	const slice = asRecord(value);
	if (!slice) return null;
	const gate = asRecord(slice.gate);
	const gateResult = asRecord(gate?.result);
	const reviews = asArray<unknown>(slice.reviews).filter((review) => asRecord(review) !== null);
	return {
		...slice,
		id: typeof slice.id === "string" ? slice.id : "",
		title: typeof slice.title === "string" ? slice.title : "Untitled change",
		owns: asStringArray(slice.owns),
		touched: asStringArray(slice.touched),
		outOfLane: asStringArray(slice.outOfLane),
		reviews,
		...(gate ? {
			gate: {
				...gate,
				excluded: asStringArray(gate.excluded),
				...(gateResult ? {
					result: {
						...gateResult,
						results: asArray<unknown>(gateResult.results).filter((result) => asRecord(result) !== null),
						mergeConflict: asStringArray(gateResult.mergeConflict),
					},
				} : {}),
			},
		} : { gate: undefined }),
	} as Slice;
}

/**
 * Older persisted tasks predate some fields that current UI components use.
 * Normalize those optional collections once as API data enters the dashboard.
 */
export function normalizeTask(value: unknown): Task {
	const task = asRecord(value);
	if (!task || typeof task.id !== "string") throw new Error("Invalid task response: expected a task with an id.");
	const checks = asArray<unknown>(task.checks).filter((check) => asRecord(check) !== null);
	const laneChangeRequests = asArray<unknown>(task.laneChangeRequests)
		.map(normalizeLaneChangeRequest)
		.filter((request): request is LaneChangeRequest => request !== null);
	return {
		...task,
		verify: asStringArray(task.verify),
		review: normalizeReviewPolicy(task.review),
		slices: asArray<unknown>(task.slices).map(normalizeSlice).filter((slice): slice is Slice => slice !== null),
		checks,
		laneChangeRequests,
	} as Task;
}

function normalizeAgentState(value: unknown): AgentState | null {
	if (value === null || value === undefined) return null;
	const state = asRecord(value);
	if (!state) return null;
	const usage = asRecord(state.usage);
	const log = asArray<unknown>(state.log).flatMap((entry) => {
		const event = asRecord(entry);
		if (!event || typeof event.event !== "string") return [];
		return [{ ...event, at: typeof event.at === "string" ? event.at : "", event: event.event }];
	});
	const { parkedAt, waitingRequestIds, ...rest } = state;
	return {
		...rest,
		usage: {
			...usage,
			inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
			outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
			cacheReadTokens: typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
		},
		log,
		...(typeof parkedAt === "string" ? { parkedAt } : {}),
		...(Array.isArray(waitingRequestIds) ? { waitingRequestIds: asStringArray(waitingRequestIds) } : {}),
	} as AgentState;
}

/** Normalize legacy live payloads too; logs and reviewer collections were not always persisted. */
export function normalizeLive(value: unknown): Live {
	const live = asRecord(value);
	if (!live || !asRecord(live.task)) throw new Error("Invalid live task response: expected task details.");
	const agents = asArray<unknown>(live.agents).flatMap((value) => {
		const agent = asRecord(value);
		if (!agent) return [];
		const reviewers = asArray<unknown>(agent.reviewers).flatMap((value) => {
			const reviewer = asRecord(value);
			if (!reviewer) return [];
			return [{ ...reviewer, role: typeof reviewer.role === "string" ? reviewer.role : "reviewer", state: normalizeAgentState(reviewer.state) }];
		});
		return [{
			...agent,
			id: typeof agent.id === "string" ? agent.id : "",
			builder: normalizeAgentState(agent.builder),
			reviewers,
		}];
	});
	return { ...live, task: normalizeTask(live.task), agents } as Live;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Not JSON: an older server without this route answers with the dashboard page.
		throw new Error(res.ok ? `Unexpected response from ${path}` : `${res.status} ${res.statusText}`);
	}
	if (!res.ok) {
		const detail = asRecord(data)?.error;
		throw new Error(res.status === 401 ? "Unauthorized: sign in through Cloudflare Access." : typeof detail === "string" ? detail : `${res.status} ${res.statusText}`);
	}
	return data as T;
}

export const api = {
	tasks: async () => {
		const tasks = await call<unknown>("GET", "/tasks");
		if (!Array.isArray(tasks)) throw new Error("Invalid tasks response: expected a list.");
		return tasks.map(normalizeTask);
	},
	live: async (id: string) => normalizeLive(await call<unknown>("GET", `/tasks/${encodeURIComponent(id)}/live`)),
	repos: () => call<{ name: string }[]>("GET", "/repos"),
	/** Every repo with its counts, for the Repositories list (one read, kept by the server). */
	summaries: () => call<Summaries>("GET", "/summaries"),
	freeRepos: () => call<{ repo: string; since: string }[]>("GET", "/free"),
	freeRepo: (repo: string) => call<FreeSnapshot>("GET", `/free/${encodeURIComponent(repo)}`),
	freeAudit: (repo: string) => call<FreeAudit>("GET", `/free/${encodeURIComponent(repo)}/audit`),
	/** Open a repo for agents (or find the task it is already open as), as the MCP join_repo tool does. */
	openRepo: async (repo: string) => normalizeTask(await call<unknown>("POST", `/repos/${encodeURIComponent(repo)}/open`, {})),
	sliceDiff: (taskId: string, sliceId: string) =>
		call<UnifiedCodeDiff>("GET", `/tasks/${encodeURIComponent(taskId)}/slices/${encodeURIComponent(sliceId)}/diff`),
	/** A person lets the commit under review through without full review (the checks still run). */
	waive: (taskId: string, sliceId: string, reason: string) =>
		call<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/slices/${encodeURIComponent(sliceId)}/waive`, { reason }),
	/** The repo's decision log from Git, oldest first. */
	history: async (taskId: string) => normalizeHistory(await call<unknown>("GET", `/tasks/${encodeURIComponent(taskId)}/history`)),
	/** Message a change's builder: delivered at its next turn, or it resumes if it stopped. */
	messageBuilder: (taskId: string, sliceId: string, message: string) =>
		call<{ delivered: "inbox" | "resumed" }>("POST", `/tasks/${encodeURIComponent(taskId)}/slices/${encodeURIComponent(sliceId)}/message`, { message }),
	/** Re-run the checks for an approved change. */
	retryChecks: (taskId: string, sliceId: string) =>
		call<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/slices/${encodeURIComponent(sliceId)}/gate`, {}),
	/** Give up a change and free its claim. */
	abandon: (taskId: string, sliceId: string, reason: string) =>
		call<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/changes/${encodeURIComponent(sliceId)}/abandon`, { reason }),
};
