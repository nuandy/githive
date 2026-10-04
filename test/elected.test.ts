import { describe, expect, it, vi } from "vitest";
import { electedCoordinator } from "../src/elected";
import { task, slice } from "./fakes/env";

// The Worker's side of the elected coordinator: which peer each call goes to.
// Peers are faked; each says who leads and records the calls it gets.

function peers(leader: string) {
	const state = { leader, deposedOnce: new Set<string>() };
	const made = new Map<string, ReturnType<typeof fakePeer>>();
	function fakePeer(name: string) {
		return {
			lead: vi.fn(async (_task: string, _repo: string, me: string, fresh = false) => ({ leader: fresh ? me : state.leader, term: 1 })),
			openChange: vi.fn(async (input: { id: string }) => {
				if (state.deposedOnce.delete(name)) throw new Error("[409] no longer leading: t1--b leads term 2");
				return { change: { id: input.id }, credentials: { slice: input.id } };
			}),
			abandonChange: vi.fn(async (id: string) => ({ id, status: "abandoned" })),
		};
	}
	const peer = (name: string) => {
		if (!made.has(name)) made.set(name, fakePeer(name));
		return made.get(name)!;
	};
	return { state, made, peer };
}

const stored = task({ id: "t1", repo: "project", mode: "open", slices: [slice("stats", { leaseUntil: "2099-01-01T00:00:00.000Z" }), slice("old", { status: "abandoned" })] });

describe("the elected coordinator, from the Worker", () => {
	it("opens a change through its own new peer, on whichever peer leads", async () => {
		const p = peers("t1--lead");
		const co = electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, readTask: async () => stored });
		const opened = await co.openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const id = opened.change.id;
		expect(id).toMatch(/^add-stats-[0-9a-f]{4}$/);
		expect(p.made.get(`t1--${id}`)?.lead).toHaveBeenCalledWith("t1", "project", `t1--${id}`, false);
		expect(p.made.get("t1--lead")?.openChange).toHaveBeenCalledWith(expect.objectContaining({ id, title: "Add stats" }), undefined);
	});

	it("asks about an existing change through that change's peer", async () => {
		const p = peers("t1--lead");
		const co = electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, readTask: async () => stored });
		await co.abandonChange("stats", "done");
		expect(p.made.get("t1--stats")?.lead).toHaveBeenCalled();
		expect(p.made.get("t1--lead")?.abandonChange).toHaveBeenCalledWith("stats", "done", undefined);
	});

	it("asks again, freshly, when the peer it called no longer leads", async () => {
		const p = peers("t1--lead");
		p.state.deposedOnce.add("t1--lead");
		const co = electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, readTask: async () => stored });
		const opened = await co.openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const own = p.made.get(`t1--${opened.change.id}`)!;
		expect(own.lead.mock.calls.map((call) => call[3])).toEqual([false, true]);
		// The fresh look made the change's own peer the leader, and it answered.
		expect(own.openChange).toHaveBeenCalled();
	});

	it("reads claims and state from the log, without asking any peer", async () => {
		const p = peers("t1--lead");
		const co = electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never, readTask: async () => stored });
		expect((await co.claims()).map((c) => c.change)).toEqual(["stats"]);
		expect((await co.state()).id).toBe("t1");
		expect(p.made.size).toBe(0);
	});
});
