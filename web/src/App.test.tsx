import { afterEach, describe, expect, it, vi } from "vitest";
import type { Live, Task } from "./api";
import type { DashboardShellApi, DashboardTimerScheduler } from "./dashboard-contract";
import {
	clearDashboardError,
	createTaskAndPlan,
	recordDashboardError,
	runDashboardAction,
	startDashboardPolling,
	startTaskListPolling,
	taskIdFromHash,
} from "./App";

const task: Task = {
	id: "task-one", repo: "repo", goal: "Build a dashboard", phase: "planning",
	contracts: [], verify: [], review: { reviewers: ["tests"], required: 1, vetoes: [] },
	slices: [], checks: [], createdAt: "2025-01-01T00:00:00.000Z",
};
const live: Live = { task, agents: [] };

class FakeScheduler implements DashboardTimerScheduler {
	private nextId = 1;
	readonly callbacks = new Map<number, { callback: () => void; milliseconds: number }>();
	readonly cleared: number[] = [];
	setInterval(callback: () => void, milliseconds: number): number {
		const id = this.nextId++;
		this.callbacks.set(id, { callback, milliseconds });
		return id;
	}
	clearInterval(id: number): void {
		this.cleared.push(id);
		this.callbacks.delete(id);
	}
	fire(milliseconds: number): void {
		for (const interval of this.callbacks.values()) if (interval.milliseconds === milliseconds) interval.callback();
	}
}

function makeApi(overrides: Partial<DashboardShellApi> = {}): DashboardShellApi {
	return {
		tasks: vi.fn().mockResolvedValue([task]), repos: vi.fn().mockResolvedValue([{ name: "repo" }]),
		live: vi.fn().mockResolvedValue(live), create: vi.fn().mockResolvedValue(task),
		plan: vi.fn().mockResolvedValue(task), approve: vi.fn().mockResolvedValue(undefined),
		build: vi.fn().mockResolvedValue(undefined), land: vi.fn().mockResolvedValue(task), ...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

describe("dashboard shell orchestration", () => {
	it("parses task hash routes and rejects malformed or unrelated hashes", () => {
		expect(taskIdFromHash("#/tasks/task-one")).toBe("task-one");
		expect(taskIdFromHash("#/tasks/a%20b/")).toBe("a b");
		expect(taskIdFromHash("#/tasks/%E0%A4%A")).toBeNull();
		expect(taskIdFromHash("#/repos/repo")).toBeNull();
	});

	it("creates before planning", async () => {
		const calls: string[] = [];
		const api = makeApi({
			create: vi.fn(async () => { calls.push("create"); return task; }),
			plan: vi.fn(async () => { calls.push("plan"); return task; }),
		});
		await expect(createTaskAndPlan(api, "repo", task.goal)).resolves.toBe(task);
		expect(calls).toEqual(["create", "plan"]);
	});

	it("approves before building and skips build after an approval failure", async () => {
		const calls: string[] = [];
		const api = makeApi({
			approve: vi.fn(async () => { calls.push("approve"); }),
			build: vi.fn(async () => { calls.push("build"); }),
		});
		await runDashboardAction(api, task.id, "approve-build");
		expect(calls).toEqual(["approve", "build"]);

		calls.length = 0;
		const rejected = makeApi({
			approve: vi.fn(async () => { calls.push("approve"); throw new Error("denied"); }),
			build: vi.fn(async () => { calls.push("build"); }),
		});
		await expect(runDashboardAction(rejected, task.id, "approve-build")).rejects.toThrow("denied");
		expect(calls).toEqual(["approve"]);
	});

	it("routes Plan and Land to the corresponding API methods", async () => {
		const api = makeApi();
		await runDashboardAction(api, task.id, "plan");
		await runDashboardAction(api, task.id, "land");
		expect(api.plan).toHaveBeenCalledWith(task.id);
		expect(api.land).toHaveBeenCalledWith(task.id);
	});

	it("polls live immediately and every three seconds, ignoring stale results and clearing the timer", async () => {
		const pending = deferred<Live>();
		const api = makeApi({ live: vi.fn().mockReturnValue(pending.promise) });
		const scheduler = new FakeScheduler();
		const onLive = vi.fn();
		const onError = vi.fn();
		let selectedId: string | null = task.id;
		const stop = startDashboardPolling(task.id, () => selectedId, api, onLive, onError, scheduler);
		expect(api.live).toHaveBeenCalledTimes(1);
		expect([...scheduler.callbacks.values()].map(({ milliseconds }) => milliseconds)).toEqual([3_000]);
		selectedId = "another-task";
		pending.resolve(live);
		await tick();
		expect(onLive).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		stop();
		expect(scheduler.cleared).toEqual([1]);
	});

	it("continues live polling when the selected task is unchanged", async () => {
		const api = makeApi();
		const scheduler = new FakeScheduler();
		const stop = startDashboardPolling(task.id, () => task.id, api, vi.fn(), vi.fn(), scheduler);
		await tick();
		scheduler.fire(3_000);
		await tick();
		expect(api.live).toHaveBeenCalledTimes(2);
		stop();
	});

	it("refreshes the task list every ten seconds and cancels its interval", () => {
		const fetchTasks = vi.fn();
		const scheduler = new FakeScheduler();
		const stop = startTaskListPolling(fetchTasks, scheduler);
		expect(fetchTasks).not.toHaveBeenCalled();
		expect([...scheduler.callbacks.values()].map(({ milliseconds }) => milliseconds)).toEqual([10_000]);
		scheduler.fire(10_000);
		expect(fetchTasks).toHaveBeenCalledTimes(1);
		stop();
		expect(scheduler.cleared).toEqual([1]);
	});

	it("retains distinct errors, deduplicates retries, and clears only the recovered operation", () => {
		const plannerError = new Error("planner unavailable");
		let errors = recordDashboardError([], "Start planning", plannerError);
		errors = recordDashboardError(errors, "Tasks", new Error("network down"));
		errors = recordDashboardError(errors, "Start planning", plannerError);
		expect(errors).toEqual(["Start planning: planner unavailable", "Tasks: network down"]);
		errors = clearDashboardError(errors, "Start planning");
		expect(errors).toEqual(["Tasks: network down"]);
	});
});
