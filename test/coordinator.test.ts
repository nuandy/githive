import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateResult } from "../src/gate-plan";
import type { Review, Task } from "../src/types";
import { FakeStorage, fakeEnv, slice, task } from "./fakes/env";

// Integration tests for the Coordinator's decisions: the real class, with
// fake storage and agents, and the Artifacts and git I/O mocked out.

const io = vi.hoisted(() => ({
	heads: new Map<string, string>(),
	mergeConflict: null as string[] | null,
	merges: [] as string[],
}));

vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));

vi.mock("../src/git", () => ({
	Workspace: {
		clone: vi.fn(async () => ({
			fetch: vi.fn(async () => "fetched"),
			merge: vi.fn(async (ref: string) => {
				if (io.mergeConflict) {
					const { default: isogit } = await import("isomorphic-git");
					throw new isogit.Errors.MergeConflictError(io.mergeConflict, io.mergeConflict, [], []);
				}
				io.merges.push(ref);
			}),
			push: vi.fn(async () => ({})),
		})),
	},
}));

const { Coordinator } = await import("../src/coordinator");

let storage: FakeStorage;
let fake: ReturnType<typeof fakeEnv>;
let coordinator: InstanceType<typeof Coordinator>;

async function setup(t: Task) {
	storage = new FakeStorage();
	fake = fakeEnv();
	await storage.put("task", t);
	coordinator = new Coordinator({ storage } as never, fake.env as never);
}

const stored = async () => (await storage.get<Task>("task"))!;
const builder = (sliceId: string) => fake.env.BUILDER.getByName(`t1--${sliceId}`);
const vote = (reviewer: string, verdict: Review["verdict"], head = "h1") => ({ reviewer, verdict, head, summary: `${reviewer} says ${verdict}` });

beforeEach(() => {
	io.heads.clear();
	io.mergeConflict = null;
	io.merges = [];
	io.heads.set("t1--base", "base0");
});

describe("limits and queues", () => {
	it("starts builders up to the limit, queues the rest, and starts the next when one stops", async () => {
		await setup(task({ slices: [slice("a"), slice("b"), slice("c")], limits: { builders: 2, reviewers: 6 } }));
		const { started } = await coordinator.startBuilders();
		expect(started.map((s) => s.status)).toEqual(["started", "started", "queued"]);
		expect(builder("c").start).not.toHaveBeenCalled();

		await coordinator.agentStopped("builder", "a");
		expect(builder("c").start).toHaveBeenCalledOnce();
		const t = await stored();
		expect(t.active.builders.sort()).toEqual(["b", "c"]);
		expect(t.queue).toEqual([]);
	});

	it("queues reviewers past the limit and drops them when the slice is sent back", async () => {
		io.heads.set("t1--a", "h1");
		await setup(task({ limits: { builders: 4, reviewers: 2 } }));
		await coordinator.startReviewers("a", "built it");
		let t = await stored();
		expect(t.active.reviewers).toEqual(["a:security:h1", "a:tests:h1"]);
		expect(t.queue).toEqual([{ kind: "reviewer", slice: "a", role: "api", head: "h1" }]);

		await coordinator.submitReview("a", vote("security", "reject")); // a veto sends it back
		t = await stored();
		expect(t.queue).toEqual([]);
		expect(builder("a").revise).toHaveBeenCalledOnce();
	});

	it("frees slots held by agents that stopped without reporting", async () => {
		await setup(task({ slices: [slice("a"), slice("b")], limits: { builders: 1, reviewers: 6 }, active: { builders: ["a"], reviewers: [] }, queue: [{ kind: "builder", slice: "b" }] }));
		// Builder a never reported stopping; its state says it's done.
		fake.agentStatus.set("t1--a", "done");
		await coordinator.agentStopped("builder", "unrelated");
		expect(builder("b").start).toHaveBeenCalledOnce();
	});

	it("drops queued work for slices that moved on", async () => {
		await setup(task({ slices: [slice("a", { status: "integrated" }), slice("b")], limits: { builders: 1, reviewers: 6 }, active: { builders: ["b"], reviewers: [] }, queue: [{ kind: "builder", slice: "a" }] }));
		await coordinator.agentStopped("builder", "b");
		expect(builder("a").start).not.toHaveBeenCalled();
		expect((await stored()).queue).toEqual([]);
	});
});

describe("votes", () => {
	beforeEach(() => io.heads.set("t1--a", "h1"));

	it("queues an approved slice with the task's gate", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		await coordinator.submitReview("a", vote("tests", "approve"));
		const { next } = await coordinator.submitReview("a", vote("api", "approve"));
		expect(next).toBe("integrate");
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1" });
		expect((await stored()).slices[0].gate?.status).toBe("queued");
	});

	it("integrates directly when the task has no verify commands", async () => {
		await setup(task({ verify: [], slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		await coordinator.submitReview("a", vote("tests", "approve"));
		await coordinator.submitReview("a", vote("api", "approve"));
		expect(io.merges).toEqual(["refs/remotes/a/main"]);
		expect((await stored()).slices[0].status).toBe("integrated");
	});

	it("sends a vetoed slice back with the findings and cancels its other reviewers", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		await coordinator.submitReview("a", { ...vote("security", "reject"), evidence: "XSS in view.ts:3" });
		const message = builder("a").revise.mock.calls[0][0];
		expect(message).toMatch(/quorum vetoed/);
		expect(message).toMatch(/XSS in view\.ts:3/);
		for (const role of ["security", "tests", "api"])
			expect(fake.env.REVIEWER.getByName(`t1--a--review-${role}--h1`).cancel).toHaveBeenCalledOnce();
		const t = await stored();
		expect(t.slices[0].revisions).toBe(1);
		expect(t.active.builders).toContain("a");
	});

	it("flags a slice for a human after the revision limit", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", revisions: 3 }), slice("b")] }));
		await coordinator.submitReview("a", vote("security", "reject"));
		expect(builder("a").revise).not.toHaveBeenCalled();
		expect((await stored()).slices[0].attention).toMatch(/Sent back 3 times/);
	});

	it("rejects a vote on a commit that is no longer under review", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h2" }), slice("b")] }));
		await expect(coordinator.submitReview("a", vote("tests", "approve", "h1"))).rejects.toThrow(/\[409\]/);
	});
});

describe("the integration gate", () => {
	const result = (overrides: Partial<GateResult> = {}): GateResult => ({
		passed: true,
		head: "h1",
		baseHead: "base0",
		results: [{ command: "npm test", exitCode: 0, output: "ok" }],
		at: "2026-10-02T00:00:00.000Z",
		...overrides,
	});
	const gated = (status: "queued" | "running" | "waiting", head = "h1") => ({ status, head, baseHead: "base0", at: "", excluded: [] });

	beforeEach(() => {
		io.heads.set("t1--a", "h1");
		io.heads.set("t1--b", "hb");
	});

	it("plans a run against the current base and marks it running", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("queued") }), slice("b")] }));
		const plan = await coordinator.gatePlan("a", "h1");
		expect(plan).toMatchObject({ baseHead: "base0", checks: ["npm test"], base: { token: "token-t1--base" } });
		expect((await stored()).slices[0].gate?.status).toBe("running");
		expect(await coordinator.gatePlan("a", "stale")).toBeNull();
	});

	it("integrates on a pass and re-queues gates that were waiting", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running") }), slice("b", { reviewHead: "hb", gate: gated("waiting", "hb") })] }));
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "passed" });
		const t = await stored();
		expect(t.slices[0].status).toBe("integrated");
		expect(t.slices[1].gate?.status).toBe("queued");
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "b", head: "hb" });
	});

	it("waits on a failure while other slices can still integrate", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running") }), slice("b")] }));
		expect(await coordinator.gateResult("a", result({ passed: false }), [])).toEqual({ outcome: "waiting" });
		expect(builder("a").revise).not.toHaveBeenCalled();
	});

	it("sends back on a failure when nothing else can integrate; slices waiting on it keep waiting", async () => {
		const failure = result({ passed: false, results: [{ command: "npm run typecheck", exitCode: 2, output: "TS2305" }] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running") }), slice("b", { reviewHead: "hb", gate: { ...gated("waiting", "hb"), result: { ...failure, head: "hb" } } })] }));
		expect(await coordinator.gateResult("a", failure, [])).toEqual({ outcome: "failed" });
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/npm run typecheck \(exit code 2\)\nTS2305/);
		expect(builder("b").revise).not.toHaveBeenCalled();
		expect((await stored()).slices[1].gate?.status).toBe("waiting");
	});

	it("re-queues a result checked against a base that has since moved", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running") }), slice("b")] }));
		io.heads.set("t1--base", "base1");
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "rerun" });
		expect((await stored()).slices[0].status).toBe("building");
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledOnce();
	});

	it("sends back a slice that no longer merges onto the base", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running") }), slice("b")] }));
		io.mergeConflict = ["src/shared.ts"];
		await coordinator.gateResult("a", result(), []);
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/conflicts with work already integrated.*src\/shared\.ts/s);
	});

	it("ignores a result for a commit that is no longer the one waiting", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h2", gate: gated("running", "h2") }), slice("b")] }));
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "stale" });
	});
});

describe("escalation and human controls", () => {
	beforeEach(() => io.heads.set("t1--a", "h1"));

	it("flags a slice whose builder finished without a new commit after a send-back", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", sentBackFor: "h1" }), slice("b")] }));
		const { escalated } = await coordinator.startReviewers("a", "can't fix this in my lane");
		expect(escalated).toBe(true);
		expect((await stored()).slices[0].attention).toMatch(/can't fix this in my lane/);
		expect(fake.env.REVIEWER.stubs.size).toBe(0);
	});

	it("refuses a waiver while the builder is working, then records it and queues the gate", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", attention: "stuck" }), slice("b")] }));
		fake.agentStatus.set("t1--a", "working");
		await expect(coordinator.waive("a", { by: "a human", reason: "reviewers asked for out-of-lane tests" })).rejects.toThrow(/still working/);

		fake.agentStatus.set("t1--a", "done");
		const s = await coordinator.waive("a", { by: "a human", reason: "reviewers asked for out-of-lane tests" });
		expect(s.waivers).toEqual([expect.objectContaining({ head: "h1", by: "a human" })]);
		expect(s.attention).toBeUndefined();
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1" });
	});

	it("delivers a message to a running builder's inbox, or resumes a stopped one", async () => {
		await setup(task());
		fake.agentStatus.set("t1--a", "working");
		expect(await coordinator.messageBuilder("a", "use the contract")).toEqual({ delivered: "inbox" });
		expect(builder("a").revise).not.toHaveBeenCalled();

		fake.agentStatus.set("t1--a", "failed");
		expect(await coordinator.messageBuilder("a", "use the contract")).toEqual({ delivered: "resumed" });
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/^Message from a human on the team: use the contract/);
		expect((await stored()).active.builders).toContain("a");
	});
});
