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
});
