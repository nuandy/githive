import { describe, expect, it, vi } from "vitest";
import { electedCoordinator } from "../src/elected";
import { task, slice } from "./fakes/env";

// The Worker's side of the elected coordinator: which peer each call goes to.
// Peers are faked; each says who leads and records the calls it gets.

const stored = task({ id: "t1", repo: "project", mode: "open", slices: [slice("stats", { leaseUntil: "2099-01-01T00:00:00.000Z" }), slice("old", { status: "abandoned" })] });

function peers(leader: string | null) {
	const state = { leader, deposedOnce: new Set<string>() };
	const made = new Map<string, ReturnType<typeof fakePeer>>();
	function fakePeer(name: string) {
		return {
			lead: vi.fn(async (_task: string, _repo: string, me: string, fresh = false) => ({ leader: fresh || !state.leader ? me : state.leader, term: 1 })),
			whoLeads: vi.fn(async () => state.leader),
			peek: vi.fn(async () => stored),
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

const elected = (p: ReturnType<typeof peers>) => electedCoordinator({ taskId: "t1", repo: "project", peer: p.peer as never });

describe("the elected coordinator, from the Worker", () => {
	it("opens a change on the leader the task's reader knows of", async () => {
		const p = peers("t1--lead");
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const id = opened.change.id;
		expect(id).toMatch(/^add-stats-[0-9a-f]{4}$/);
		expect(p.made.get("t1--reader")?.whoLeads).toHaveBeenCalled();
		expect(p.made.get("t1--lead")?.openChange).toHaveBeenCalledWith(expect.objectContaining({ id, title: "Add stats" }), undefined);
		// The new change's own peer wasn't needed.
		expect(p.made.has(`t1--${id}`)).toBe(false);
	});

	it("has the new change's own peer lead when nobody's lease is live", async () => {
		const p = peers(null);
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const own = p.made.get(`t1--${opened.change.id}`)!;
		expect(own.lead).toHaveBeenCalledWith("t1", "project", `t1--${opened.change.id}`, false);
		expect(own.openChange).toHaveBeenCalled();
	});

	it("asks about an existing change through that change's peer", async () => {
		const p = peers("t1--lead");
		await elected(p).abandonChange("stats", "done");
		expect(p.made.get("t1--stats")?.lead).toHaveBeenCalled();
		expect(p.made.get("t1--lead")?.abandonChange).toHaveBeenCalledWith("stats", "done", undefined);
	});

	it("asks afresh when the leader it was told of no longer leads", async () => {
		const p = peers("t1--lead");
		p.state.deposedOnce.add("t1--lead");
		const opened = await elected(p).openChange({ title: "Add stats", intent: "x", owns: ["src/stats/"] });
		const own = p.made.get(`t1--${opened.change.id}`)!;
		expect(own.lead).toHaveBeenCalledWith("t1", "project", `t1--${opened.change.id}`, true);
		expect(own.openChange).toHaveBeenCalled();
	});

	it("reads claims and state through the task's reader peer, which never campaigns", async () => {
		const p = peers("t1--lead");
		const co = elected(p);
		expect((await co.claims()).map((c) => c.change)).toEqual(["stats"]);
		expect((await co.state()).id).toBe("t1");
		expect([...p.made.keys()]).toEqual(["t1--reader"]);
		expect(p.made.get("t1--reader")?.lead).not.toHaveBeenCalled();
	});
});
