import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate's queue bookkeeping, with the Coordinator faked. The container work
// is skipped by having the Coordinator return no plan.

const { Gate } = await import("../src/gate");

function gateWith(coordinator: { gatePlan: ReturnType<typeof vi.fn>; gateResult: ReturnType<typeof vi.fn> }) {
	const storage = new FakeStorage();
	const env = { COORDINATOR: { idFromName: (n: string) => n, get: () => coordinator } };
	return { gate: new Gate({ storage } as never, env as never), storage };
}

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
		const { queue } = await gate.state();
		expect(queue).toEqual([expect.objectContaining({ slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] })]);
	});

	it("replaces a queued item for the same slices", async () => {
		const { gate } = gateWith({ gatePlan: vi.fn(), gateResult: vi.fn() });
		await gate.enqueue("t1", { slice: "a", head: "h1" });
		await gate.enqueue("t1", { slice: "a", head: "h2" });
		expect((await gate.state()).queue.map((q) => q.head)).toEqual(["h2"]);
	});
});
