import { describe, expect, it } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "./fakes/env";

// Milestone 5: open mode has no fixed Coordinator. A repo opened before the
// elected coordinator existed has its open task on a Coordinator object; it
// hands the task over (its state starts the elected log) and from then on
// refuses everything, so nothing decides for the task in two places.

const { Coordinator } = await import("../src/coordinator");

function coordinatorWith(stored: ReturnType<typeof task>) {
	const storage = new FakeStorage();
	const coordinator = new Coordinator({ storage } as never, fakeEnv().env as never);
	return { storage, coordinator, ready: storage.put("task", stored) };
}

describe("handing an open task over to the elected coordinator", () => {
	it("returns the task's state, then refuses everything and stops its timers", async () => {
		const open = task({ id: "t-open", repo: "project", mode: "open", slices: [slice("stats", { leaseUntil: "2099-01-01T00:00:00.000Z" })] });
		const { storage, coordinator, ready } = coordinatorWith(open);
		await ready;
		await storage.setAlarm(Date.now() + 60_000);

		expect(await coordinator.handOver()).toMatchObject({ id: "t-open", mode: "open", slices: [{ id: "stats" }] });
		await expect(coordinator.state()).rejects.toThrow("moved to the elected coordinator");
		expect(storage.alarm).toBeNull();
		// A late alarm does nothing, and handing over again returns the same state.
		await coordinator.alarm();
		expect(await coordinator.handOver()).toMatchObject({ id: "t-open" });
	});

	it("refuses to hand over a planned task, which stays with its Coordinator", async () => {
		const { coordinator, ready } = coordinatorWith(task({ id: "t-plan", repo: "project" }));
		await ready;
		await expect(coordinator.handOver()).rejects.toThrow("only an open task moves to the elected coordinator");
		expect(await coordinator.state()).toMatchObject({ id: "t-plan" });
	});
});
