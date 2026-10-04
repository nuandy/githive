import { vi } from "vitest";
import type { GateItem } from "../../src/gate";
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
	async list<T>(options: { prefix?: string; reverse?: boolean; limit?: number } = {}) {
		const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
		if (options.reverse) keys.reverse();
		return new Map(keys.slice(0, options.limit ?? keys.length).map((k) => [k, structuredClone(this.data.get(k)) as T]));
	}
	async delete(key: string | string[]) {
		for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k);
	}
	async setAlarm(at: number) {
		this.alarm = at;
	}
	async deleteAlarm() {
		this.alarm = null;
	}
	async deleteAll() {
		this.data.clear();
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
	/** What the Gate reports as queued and running. */
	const gateQueue: GateItem[] = [];
	const gateCurrent: { item: GateItem | null } = { item: null };
	const agent = (name: string) => {
		const a = {
			start: vi.fn(async (_job: unknown) => void agentStatus.set(name, "queued")),
			revise: vi.fn(async (_message: string, _credentials?: unknown) => void agentStatus.set(name, "queued")),
			notify: vi.fn(async (_message: string) => ["queued", "working"].includes(agentStatus.get(name) ?? "")),
			cancel: vi.fn(async (_reason: string) => true),
			state: vi.fn(async () => (agentStatus.has(name) ? { status: agentStatus.get(name) } : null)),
			park: vi.fn(async (_parkedAt: string, _waitingFor: string[]) => void agentStatus.set(name, "done")),
			markParkTimedOut: vi.fn(async () => true),
			/** Like the real Builder: once per event id; to the inbox if running, otherwise resume. */
			wake: vi.fn(async (eventId: string, message: string, credentials?: unknown): Promise<"resumed" | "deferred" | "ignored"> => {
				if (delivered.has(`${name}:${eventId}`)) return "ignored";
				delivered.add(`${name}:${eventId}`);
				if (await a.notify(message)) return "deferred";
				await a.revise(message, credentials);
				return "resumed";
			}),
		};
		return a;
	};
	const delivered = new Set<string>();
	const env = {
		BUILDER: namespace(agent),
		REVIEWER: namespace(agent),
		GATE: namespace(() => ({
			enqueue: vi.fn(async (_taskId: string, _item: unknown) => {}),
				cancel: vi.fn(async (_taskId: string, _slice: string, _head: string) => {}),
			state: vi.fn(async () => ({ queue: gateQueue, current: gateCurrent.item })),
		})),
		CONTRACT_CHECKER: namespace(() => ({
			check: vi.fn(async (job: { contracts: Record<string, string> }) => ({ status: "passed" as const, checked: Object.keys(job.contracts), unchecked: [] })),
			dispose: vi.fn(async () => undefined),
		})),
		ARTIFACTS: {},
		OPENAI_API_KEY: "test",
	};
	return { env, agentStatus, gateQueue, gateCurrent };
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
