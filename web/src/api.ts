import type { Task } from "../../src/types";

export type { Task };
export type Slice = Task["slices"][number];

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

/** A builder's or reviewer's public state (see src/sandbox.ts). */
export interface AgentState {
	status: "queued" | "working" | "done" | "failed";
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
	// Reviewers
	verdict?: "approve" | "reject";
	evidence?: string;
	quorum?: string;
}

export interface Live {
	task: Task;
	agents: { id: string; builder: AgentState | null; reviewers: { role: string; state: AgentState | null }[] }[];
}

const TOKEN_KEY = "blueprint.token";

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

function normalizeSlice(value: unknown): Slice | null {
	const slice = asRecord(value);
	if (!slice) return null;
	const gate = asRecord(slice.gate);
	const gateResult = asRecord(gate?.result);
	const reviews = asArray<unknown>(slice.reviews).filter((review) => asRecord(review) !== null);
	return {
		...slice,
		id: typeof slice.id === "string" ? slice.id : "",
		title: typeof slice.title === "string" ? slice.title : "Untitled slice",
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
	const amendments = asArray<unknown>(task.amendments).filter((amendment) => asRecord(amendment) !== null);
	return {
		...task,
		contracts: asStringArray(task.contracts),
		verify: asStringArray(task.verify),
		review: normalizeReviewPolicy(task.review),
		slices: asArray<unknown>(task.slices).map(normalizeSlice).filter((slice): slice is Slice => slice !== null),
		checks,
		amendments,
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
	return {
		...state,
		usage: {
			...usage,
			inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
			outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
			cacheReadTokens: typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
		},
		log,
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

export function getToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

export function setToken(token: string) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// Storage unavailable (private mode): the token lasts for this page only.
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const token = getToken();
	if (method !== "GET" && token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	const data = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const detail = asRecord(data)?.error;
		throw new Error(res.status === 401 ? "Unauthorized: set your API token." : typeof detail === "string" ? detail : `${res.status} ${res.statusText}`);
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
	create: async (repo: string, goal: string) => normalizeTask(await call<unknown>("POST", "/tasks", { repo, goal })),
	plan: async (id: string) => normalizeTask(await call<unknown>("POST", `/tasks/${encodeURIComponent(id)}/plan`)),
	approve: (id: string) => call<unknown>("POST", `/tasks/${encodeURIComponent(id)}/approve`),
	build: (id: string) => call<unknown>("POST", `/tasks/${encodeURIComponent(id)}/build`),
	land: async (id: string) => normalizeTask(await call<unknown>("POST", `/tasks/${encodeURIComponent(id)}/land`)),
};
