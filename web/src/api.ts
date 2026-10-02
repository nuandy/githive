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
	if (!res.ok) throw new Error(res.status === 401 ? "Unauthorized: set your API token." : (data?.error ?? `${res.status} ${res.statusText}`));
	return data as T;
}

export const api = {
	tasks: () => call<Task[]>("GET", "/tasks"),
	live: (id: string) => call<Live>("GET", `/tasks/${id}/live`),
	repos: () => call<{ name: string }[]>("GET", "/repos"),
	create: (repo: string, goal: string) => call<Task>("POST", "/tasks", { repo, goal }),
	plan: (id: string) => call<Task>("POST", `/tasks/${id}/plan`),
	approve: (id: string) => call<unknown>("POST", `/tasks/${id}/approve`),
	build: (id: string) => call<unknown>("POST", `/tasks/${id}/build`),
	land: (id: string) => call<Task>("POST", `/tasks/${id}/land`),
};
