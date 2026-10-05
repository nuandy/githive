import { describe, expect, it, vi } from "vitest";
import type { GateResult } from "../../src/gate-plan";
import { FakeStorage } from "../fakes/env";

const { Gate } = await import("../../src/gate");

function makeGate(coordinator: { gatePlan: ReturnType<typeof vi.fn>; gateResult: ReturnType<typeof vi.fn> }) {
	const storage = new FakeStorage();
	const env = { COORDINATOR: { idFromName: (name: string) => name, get: () => coordinator }, TASK_INDEX: { getByName: () => ({ get: async () => null }) } };
	return new Gate({ storage } as never, env as never);
}

const plan = {
	baseHead: "base0",
	base: { remote: "https://git.test/base.git", token: "base-token" },
	fork: { remote: "https://git.test/a.git", token: "slice-token" },
	others: [],
	checks: ["npm test"],
	exclude: [],
};

const passed: GateResult = {
	passed: true,
	head: "h1",
	baseHead: "base0",
	results: [{ command: "npm test", exitCode: 0, output: "ok" }],
	at: "2026-10-02T00:00:00.000Z",
};

describe("gate cancellation contract", () => {
	it("cancels an entire queued group only when the member head matches", async () => {
		const coordinator = { gatePlan: vi.fn(), gateResult: vi.fn() };
		const gate = makeGate(coordinator);
		await gate.enqueue("t1", { slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] });
		await gate.enqueue("t1", { slice: "c", head: "hc" });

		await gate.cancel("t1", "b", "another-head");
		expect((await gate.state()).queue).toHaveLength(2);
		await gate.cancel("t1", "b", "hb");
		expect((await gate.state()).queue.map((item) => item.slice)).toEqual(["c"]);
	});

	it("does not report a current group after one member is vetoed during its check", async () => {
		const coordinator = { gatePlan: vi.fn(async () => plan), gateResult: vi.fn(async () => undefined) };
		const gate = makeGate(coordinator);
		let entered!: () => void;
		let release!: () => void;
		const checking = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		Object.defineProperty(gate, "check", {
			value: async () => {
				entered();
				await checking;
				return passed;
			},
		});
		await gate.enqueue("t1", { slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] });

		const run = gate.alarm();
		await started;
		expect((await gate.state()).current).toMatchObject({ slice: "a", group: [{ slice: "b", head: "hb" }] });
		await gate.cancel("t1", "b", "hb");
		release();
		await run;
		expect(coordinator.gateResult).not.toHaveBeenCalled();
	});
});
