import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate's queue bookkeeping, with the Coordinator faked. The container work
// is skipped by having the Coordinator return no plan.

const { Gate } = await import("../src/gate");

function gateWith(coordinator: { gatePlan: ReturnType<typeof vi.fn>; gateResult: ReturnType<typeof vi.fn> }) {
	const storage = new FakeStorage();
	const env = { COORDINATOR: { idFromName: (n: string) => n, get: () => coordinator }, TASK_INDEX: { getByName: () => ({ get: async () => null }) } };
	return { gate: new Gate({ storage } as never, env as never), storage };
}

const plan = {
	baseHead: "base0",
	base: { remote: "https://git.test/base.git", token: "base-token" },
	fork: { remote: "https://git.test/a.git", token: "slice-token" },
	others: [],
	checks: ["npm test"],
	exclude: [],
};

describe("gate queue", () => {
	it("keeps an item queued during a run for the same slice and commit", async () => {
		// While running a's solo item, the Coordinator queues a group item that also leads with a@h1.
		let gate!: InstanceType<typeof Gate>;
		const coordinator = {
			gatePlan: vi.fn(async () => {
				await gate.enqueue("t1", { slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] });
				return null;
			}),
			gateResult: vi.fn(),
		};
		const made = gateWith(coordinator);
		gate = made.gate;
		await gate.enqueue("t1", { slice: "a", head: "h1" });
		await gate.alarm();
		const { queue, current } = await gate.state();
		expect(queue).toEqual([expect.objectContaining({ slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] })]);
		expect(current).toBeNull();
	});

	it("replaces a queued item for the same slices", async () => {
		const { gate } = gateWith({ gatePlan: vi.fn(), gateResult: vi.fn() });
		await gate.enqueue("t1", { slice: "a", head: "h1" });
		await gate.enqueue("t1", { slice: "a", head: "h2" });
		expect((await gate.state()).queue.map((q) => q.head)).toEqual(["h2"]);
	});

	it("does not start a plan when its queued item was cancelled", async () => {
		const coordinator = { gatePlan: vi.fn(async () => plan), gateResult: vi.fn() };
		const { gate } = gateWith(coordinator);
		await gate.enqueue("t1", { slice: "a", head: "h1" });
		await gate.cancel("t1", "a", "h1");

		await gate.alarm();
		expect(coordinator.gatePlan).not.toHaveBeenCalled();
		expect(coordinator.gateResult).not.toHaveBeenCalled();
		expect((await gate.state()).queue).toEqual([]);
	});

	it("allows a later retry of the same commit after cancellation", async () => {
		const coordinator = { gatePlan: vi.fn(async () => null), gateResult: vi.fn() };
		const { gate } = gateWith(coordinator);
		await gate.enqueue("t1", { slice: "a", head: "h1" });
		await gate.cancel("t1", "a", "h1");
		await gate.enqueue("t1", { slice: "a", head: "h1" });

		await gate.alarm();
		expect(coordinator.gatePlan).toHaveBeenCalledTimes(1);
		expect((await gate.state()).queue).toEqual([]);
	});

	it("checks cancellation again after the coordinator returns a plan", async () => {
		const coordinator = { gatePlan: vi.fn(), gateResult: vi.fn() };
		const { gate } = gateWith(coordinator);
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		coordinator.gatePlan.mockImplementation(async () => {
			entered();
			await waiting;
			return plan;
		});
		const check = vi.fn();
		Object.defineProperty(gate, "check", { value: check });
		await gate.enqueue("t1", { slice: "a", head: "h1" });

		const run = gate.alarm();
		await started;
		await gate.cancel("t1", "a", "h1");
		release();
		await run;
		expect(check).not.toHaveBeenCalled();
		expect(coordinator.gateResult).not.toHaveBeenCalled();
		expect((await gate.state()).current).toBeNull();
	});

	it("keeps a result it couldn't report, and reports it on its next alarm instead of losing it", async () => {
		const result = { passed: true, head: "h1", baseHead: "base0", results: [{ command: "npm test", exitCode: 0, output: "" }], at: "2026-10-06T00:00:00Z" };
		const coordinator = { gatePlan: vi.fn(async () => plan), gateResult: vi.fn() };
		const { gate, storage } = gateWith(coordinator);
		Object.defineProperty(gate, "check", { value: vi.fn(async () => result) });
		// The coordinator's leader was reset just as the run finished.
		coordinator.gateResult.mockRejectedValueOnce(new Error("Durable Object's isolate exceeded its memory limit and was reset."));
		await gate.enqueue("t1", { slice: "a", head: "h1" });

		await gate.alarm();
		expect(coordinator.gateResult).toHaveBeenCalledTimes(1);
		expect(await storage.get("unreported")).toMatchObject({ item: { slice: "a", head: "h1" }, result });
		expect((await gate.state()).queue).toEqual([]);

		await gate.alarm();
		expect(coordinator.gateResult).toHaveBeenCalledTimes(2);
		expect(coordinator.gateResult).toHaveBeenLastCalledWith("a", result, [], undefined);
		expect(await storage.get("unreported")).toBeUndefined();
		// Not run again: the checks ran once.
		expect(coordinator.gatePlan).toHaveBeenCalledTimes(1);
	});
});

describe("warming a coordinator-free repo's lanes", () => {
	it("returns at once, then warms this Gate and the three beside it in the background", async () => {
		const storage = new FakeStorage();
		const lanes = new Map<string, ReturnType<typeof vi.fn>>();
		const env = { GATE: { getByName: (name: string) => ({ warm: lanes.set(name, lanes.get(name) ?? vi.fn(async () => undefined)).get(name)! }) } };
		const gate = new Gate({ storage, setAlarm: undefined } as never, env as never);
		const input = { repo: "express", branch: "master", base: { remote: "https://git.test/express.git", token: "read" }, checks: ["npm install", "npm test"] };
		await gate.warmLanes(input);
		expect(storage.alarm).not.toBeNull();
		expect(lanes.size).toBe(0);
		await gate.alarm();
		expect([...lanes.keys()].sort()).toEqual(["free:express:lane:1", "free:express:lane:2", "free:express:lane:3"]);
		const { repo: _repo, ...warmed } = input;
		for (const warm of lanes.values()) expect(warm).toHaveBeenCalledWith(warmed);
		expect(await storage.get("warmLanes")).toBeUndefined();
	});

	it("doesn't warm a repo with no checks", async () => {
		const storage = new FakeStorage();
		const gate = new Gate({ storage } as never, {} as never);
		await gate.warmLanes({ repo: "express", base: { remote: "r", token: "t" }, checks: [] });
		expect(storage.alarm).toBeNull();
	});
});
