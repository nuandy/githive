import { describe, expect, it, vi } from "vitest";
import { electedCoordinator } from "../src/elected";
import { task, slice } from "./fakes/env";

// The Worker's side of the elected coordinator: which peer each call goes to.
// The task index's hint names the leader; peers are faked, each saying who
// leads and recording the calls it gets.

const stored = task({ id: "t1", repo: "project", mode: "open", slices: [slice("stats", { leaseUntil: "2099-01-01T00:00:00.000Z" }), slice("old", { status: "abandoned" })] });

function peers(leader: string | null) {
	const state = { leader, deposedOnce: new Set<string>() };
	const made = new Map<string, ReturnType<typeof fakePeer>>();
	function fakePeer(name: string) {
		return {
			lead: vi.fn(async (_task: string, _repo: string, me: string, fresh = false) => ({ leader: fresh || !state.leader ? me : state.leader, term: 1 })),
			peek: vi.fn(async () => stored),
			openChange: vi.fn(async (input: { id: string }) => {
				if (state.deposedOnce.delete(name)) throw new Error("[409] no longer leading: t1--b leads term 2");
				return { change: { id: input.id }, credentials: { slice: input.id } };
			}),
			abandonChange: vi.fn(async (id: string) => ({ id, status: "abandoned" })),
			// Workers' callbacks.
			submitReview: vi.fn(async () => ({ quorum: { status: "approved" } })),
			agentStopped: vi.fn(async () => undefined),
			flagSlice: vi.fn(async () => undefined),
			parkBuilder: vi.fn(async () => ({ outcome: "parked" })),
			parkedBuilderTimedOut: vi.fn(async () => undefined),
			gatePlan: vi.fn(async () => ({ baseHead: "b0" })),
			gateResult: vi.fn(async () => undefined),
			// Human controls, from the dashboard.
			sliceDiff: vi.fn(async () => ({ files: [] })),
			waive: vi.fn(async () => undefined),
			messageBuilder: vi.fn(async () => undefined),
			retryGate: vi.fn(async () => undefined),
		};
	}
	const peer = (name: string) => {
		if (!made.has(name)) made.set(name, fakePeer(name));
		return made.get(name)!;
	};
	return { state, made, peer };
}

const elected = (p: ReturnType<typeof peers>, readLog = vi.fn(async () => stored)) =>
	electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, hint: p.state.leader, readLog });

describe("the elected coordinator, from the Worker", () => {
	it("opens a change on the leader the task index names", async () => {
		const p = peers("t1--lead");
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const id = opened.change.id;
		expect(id).toMatch(/^add-stats-[0-9a-f]{4}$/);
		expect(p.made.get("t1--lead")?.openChange).toHaveBeenCalledWith(expect.objectContaining({ id, title: "Add stats" }), undefined);
		expect([...p.made.keys()]).toEqual(["t1--lead"]);
	});

	it("has the new change's own peer lead when nobody leads", async () => {
		const p = peers(null);
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const own = p.made.get(`t1--${opened.change.id}`)!;
		expect(own.lead).toHaveBeenCalledWith("t1", "project", `t1--${opened.change.id}`, false);
		expect(own.openChange).toHaveBeenCalled();
	});

	it("asks about an existing change on the leader the task index names", async () => {
		const p = peers("t1--lead");
		await elected(p).abandonChange("stats", "done");
		expect(p.made.get("t1--lead")?.abandonChange).toHaveBeenCalledWith("stats", "done", undefined);
		expect(p.made.has("t1--stats")).toBe(false);
	});

	it("has the change's own peer lead when nobody leads", async () => {
		const p = peers(null);
		await elected(p).abandonChange("stats", "done");
		expect(p.made.get("t1--stats")?.lead).toHaveBeenCalledWith("t1", "project", "t1--stats", false);
		expect(p.made.get("t1--stats")?.abandonChange).toHaveBeenCalled();
	});

	it("goes through the change's own peer, looking afresh, when the named leader no longer leads", async () => {
		const p = peers("t1--lead");
		p.state.deposedOnce.add("t1--lead");
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const own = p.made.get(`t1--${opened.change.id}`)!;
		expect(own.lead).toHaveBeenCalledWith("t1", "project", `t1--${opened.change.id}`, true);
		expect(own.openChange).toHaveBeenCalled();
	});

	it("reads claims and state from the leader the task index names", async () => {
		const p = peers("t1--lead");
		const readLog = vi.fn(async () => stored);
		const co = elected(p, readLog);
		expect((await co.claims()).map((c) => c.change)).toEqual(["stats"]);
		expect((await co.state()).id).toBe("t1");
		expect([...p.made.keys()]).toEqual(["t1--lead"]);
		expect(p.made.get("t1--lead")?.lead).not.toHaveBeenCalled();
		expect(readLog).not.toHaveBeenCalled();
	});

	it("reads from Git when nobody leads", async () => {
		const p = peers(null);
		const readLog = vi.fn(async () => stored);
		expect((await elected(p, readLog).state()).id).toBe("t1");
		expect(readLog).toHaveBeenCalled();
		expect(p.made.size).toBe(0);
	});

	it("sends workers' callbacks (reviewers, builders, the gate) to the leader the task index names", async () => {
		const p = peers("t1--lead");
		const co = elected(p);
		const review = { reviewer: "tests", head: "h1", verdict: "approve" as const, summary: "ok", evidence: "ok" };
		const result = { passed: true, head: "h1", baseHead: "b0", results: [], at: "" };
		await co.submitReview("stats", review);
		await co.agentStopped("reviewer", "stats:tests:h1");
		await co.agentStopped("builder", "stats");
		await co.flagSlice("stats", "the builder stopped");
		await co.parkBuilder("stats");
		await co.parkedBuilderTimedOut("stats", "2026-10-06T00:00:00.000Z");
		await co.gatePlan("stats", "h1", undefined);
		await co.gateResult("stats", result, [], undefined);
		const lead = p.made.get("t1--lead")!;
		expect(lead.submitReview).toHaveBeenCalledWith("stats", review);
		expect(lead.agentStopped).toHaveBeenCalledWith("reviewer", "stats:tests:h1");
		expect(lead.agentStopped).toHaveBeenCalledWith("builder", "stats");
		expect(lead.flagSlice).toHaveBeenCalledWith("stats", "the builder stopped");
		expect(lead.parkBuilder).toHaveBeenCalledWith("stats");
		expect(lead.parkedBuilderTimedOut).toHaveBeenCalledWith("stats", "2026-10-06T00:00:00.000Z");
		expect(lead.gatePlan).toHaveBeenCalledWith("stats", "h1", undefined);
		expect(lead.gateResult).toHaveBeenCalledWith("stats", result, [], undefined);
		expect([...p.made.keys()]).toEqual(["t1--lead"]);
	});

	it("sends a worker's callback through its change's own peer when nobody leads", async () => {
		const p = peers(null);
		await elected(p).agentStopped("reviewer", "stats:tests:h1");
		expect(p.made.get("t1--stats")?.lead).toHaveBeenCalledWith("t1", "project", "t1--stats", false);
		expect(p.made.get("t1--stats")?.agentStopped).toHaveBeenCalledWith("reviewer", "stats:tests:h1");
	});

	it("waits out a leader that is unavailable, then reaches the peer that takes over", async () => {
		const p = peers("t1--lead");
		const crashed = p.peer("t1--lead");
		crashed.agentStopped.mockRejectedValue(new Error("[503] peer unavailable (simulated crash)"));
		// The change's own peer sees the crashed leader's lease twice more, then takes over.
		const own = p.peer("t1--stats");
		let asked = 0;
		own.lead.mockImplementation(async (_t: string, _r: string, me: string) => ({ leader: ++asked <= 2 ? "t1--lead" : me, term: asked <= 2 ? 1 : 2 }));
		const waits: number[] = [];
		await electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, hint: "t1--lead", readLog: async () => stored, wait: async (ms) => void waits.push(ms) }).agentStopped("reviewer", "stats:tests:h1");
		expect(own.agentStopped).toHaveBeenCalledWith("reviewer", "stats:tests:h1");
		expect(waits.length).toBeGreaterThan(0);
	});

	it("asks a standby peer when the change's own peer is the one that crashed", async () => {
		const p = peers(null);
		p.peer("t1--stats").lead.mockRejectedValue(new Error("[503] peer unavailable (simulated crash)"));
		await electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, hint: null, readLog: async () => stored, wait: async () => {} }).agentStopped("builder", "stats");
		expect(p.made.get("t1--standby")?.agentStopped).toHaveBeenCalledWith("builder", "stats");
	});

	it("gives up after its patience, saying the leader is unavailable", async () => {
		const p = peers("t1--lead");
		p.peer("t1--lead").agentStopped.mockRejectedValue(new Error("[503] peer unavailable (simulated crash)"));
		p.peer("t1--stats").lead.mockResolvedValue({ leader: "t1--lead", term: 1 });
		const co = electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, hint: "t1--lead", readLog: async () => stored, wait: async () => {}, patienceMs: 0 });
		await expect(co.agentStopped("builder", "stats")).rejects.toThrow(/unavailable/);
	});

	it("sends a person's controls (a change's diff, a waiver, a message to its builder, a gate retry) to the leader", async () => {
		const p = peers("t1--lead");
		const co = elected(p);
		const person = { kind: "person" as const, value: "human@example.com" };
		await co.sliceDiff("stats");
		await co.waive("stats", { reason: "checked by hand" }, person);
		await co.messageBuilder("stats", "use the new helper", person);
		await co.retryGate("stats", person);
		const lead = p.made.get("t1--lead")!;
		expect(lead.sliceDiff).toHaveBeenCalledWith("stats");
		expect(lead.waive).toHaveBeenCalledWith("stats", { reason: "checked by hand" }, person);
		expect(lead.messageBuilder).toHaveBeenCalledWith("stats", "use the new helper", person);
		expect(lead.retryGate).toHaveBeenCalledWith("stats", person);
	});
});
