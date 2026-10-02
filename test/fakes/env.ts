import { vi } from "vitest";
import { DEFAULT_POLICY, type Slice, type Task } from "../../src/types";

/** In-memory Durable Object storage; values are copied in and out, like the real thing. */
export class FakeStorage {
	readonly data = new Map<string, unknown>();
	alarm: number | null = null;
	async get<T>(key: string): Promise<T | undefined> {
		return structuredClone(this.data.get(key)) as T | undefined;
	}
	async put(key: string | Record<string, unknown>, value?: unknown) {
		if (typeof key === "string") this.data.set(key, structuredClone(value));
		else for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
	}
	async delete(key: string | string[]) {
		for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k);
	}
	async setAlarm(at: number) {
		this.alarm = at;
	}
}

/** A Durable Object namespace whose stubs record calls; `make` builds each stub. */
export function namespace<T>(make: (name: string) => T) {
	const stubs = new Map<string, T>();
	return {
		stubs,
		getByName(name: string) {
			if (!stubs.has(name)) stubs.set(name, make(name));
			return stubs.get(name)!;
		},
	};
}

export type AgentStatus = "queued" | "working" | "done" | "failed";

/** Fake bindings: builders, reviewers and the gate record calls; their state can be set per test. */
export function fakeEnv() {
	const agentStatus = new Map<string, AgentStatus>();
	const agent = (name: string) => ({
		start: vi.fn(async (_job: unknown) => void agentStatus.set(name, "queued")),
		revise: vi.fn(async (_message: string, _credentials?: unknown) => void agentStatus.set(name, "queued")),
		notify: vi.fn(async (_message: string) => ["queued", "working"].includes(agentStatus.get(name) ?? "")),
		cancel: vi.fn(async (_reason: string) => true),
		state: vi.fn(async () => (agentStatus.has(name) ? { status: agentStatus.get(name) } : null)),
	});
	const env = {
		BUILDER: namespace(agent),
		REVIEWER: namespace(agent),
		GATE: namespace(() => ({ enqueue: vi.fn(async (_taskId: string, _item: unknown) => {}) })),
		ARTIFACTS: {},
		OPENAI_API_KEY: "test",
	};
	return { env, agentStatus };
}

export const slice = (id: string, overrides: Partial<Slice> = {}): Slice => ({
	id,
	title: id,
	owns: [`src/${id}/`],
	instructions: `build ${id}`,
	tests: [],
	status: "building",
	repo: `t1--${id}`,
	head: "base0",
	touched: [],
	outOfLane: [],
	reviews: [],
	...overrides,
});

export const task = (overrides: Partial<Task> = {}): Task => ({
	id: "t1",
	repo: "project",
	goal: "a goal",
	phase: "building",
	baseRepo: "t1--base",
	baseCommit: "base0",
	contracts: [],
	verify: ["npm test"],
	review: { ...DEFAULT_POLICY },
	slices: [slice("a"), slice("b")],
	checks: [],
	amendments: [],
	limits: { builders: 4, reviewers: 6 },
	queue: [],
	active: { builders: [], reviewers: [] },
	createdAt: "2026-10-02T00:00:00.000Z",
	...overrides,
});
