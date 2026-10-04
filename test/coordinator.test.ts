import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateResult } from "../src/gate-plan";
import type { AccessIdentity } from "../src/access-contract";
import type { Review, Slice, Task } from "../src/types";
import { FakeStorage, fakeEnv, slice, task } from "./fakes/env";

// Integration tests for the Coordinator's decisions: the real class, with
// fake storage and agents, and the Artifacts and git I/O mocked out.

const io = vi.hoisted(() => ({
	heads: new Map<string, string>(),
	mergeConflict: null as string[] | null,
	/** Only merges of this ref conflict, when set. */
	conflictOn: null as string | null,
	merges: [] as string[],
	/** The head of any repo not in heads (open-mode forks get random names). */
	defaultHead: undefined as string | undefined,
	pushes: 0,
	/** Files on the task base, by path: what fileVersion reads. */
	files: new Map<string, { id: string; text: string }>(),
	/** Files committed to the task base through a Workspace. */
	written: [] as Record<string, string>[],
	/** The contract owner's answer; may change files while it "decides". */
	decide: vi.fn(async () => ({ approve: true, reason: "fine" })),
}));

vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo) ?? io.defaultHead),
	forkAndWait: vi.fn(async (_artifacts: unknown, _source: string, name: string) => ({ remote: `https://git.test/${name}.git`, token: `token-${name}` })),
	fileVersion: vi.fn(async (_artifacts: unknown, _repo: string, path: string) => io.files.get(path) ?? null),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));

vi.mock("../src/git", () => ({
	Workspace: {
		clone: vi.fn(async () => ({
			fetch: vi.fn(async () => "fetched"),
			merge: vi.fn(async (ref: string) => {
				if (io.mergeConflict && (!io.conflictOn || io.conflictOn === ref)) {
					const { default: isogit } = await import("isomorphic-git");
					throw new isogit.Errors.MergeConflictError(io.mergeConflict, io.mergeConflict, [], []);
				}
				io.merges.push(ref);
			}),
			push: vi.fn(async () => void io.pushes++),
			write: vi.fn(async (files: Record<string, string>) => {
				io.written.push(files);
				for (const [path, text] of Object.entries(files)) io.files.set(path, { id: `v-${text}`, text });
			}),
			commit: vi.fn(async () => "amend-commit"),
		})),
	},
}));

vi.mock("../src/contract-owner", () => ({ NEW_FILE: "(new)", decideAmendment: (...args: unknown[]) => io.decide(...(args as [])) }));

// The task's notes ref, in memory: each write appends a commit message.
const ledger = vi.hoisted(() => ({ messages: [] as string[], entries: [] as { commit: string; text: string }[], down: false }));

vi.mock("../src/ledger-git", async () => {
	const { ledgerMessage } = await import("../src/ledger");
	return {
		appendLedger: vi.fn(async (_remote: unknown, _taskId: string, entries: { commit: string; text: string; at: string }[], patch: never) => {
			if (ledger.down) throw new Error("git is down");
			ledger.messages.push(ledgerMessage(entries, patch));
			ledger.entries.push(...entries);
		}),
		readLedger: vi.fn(async () => [...ledger.messages]),
	};
});

const { Coordinator } = await import("../src/coordinator");

const person: AccessIdentity = { kind: "person", value: "human@example.com" };
const service: AccessIdentity = { kind: "service", value: "deploy-script" };

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
const approvedReviews = (head = "h1") => [
	{ ...vote("tests", "approve", head), at: "" },
	{ ...vote("api", "approve", head), at: "" },
];

beforeEach(() => {
	io.heads.clear();
	io.mergeConflict = null;
	io.defaultHead = undefined;
	io.conflictOn = null;
	io.merges = [];
	io.pushes = 0;
	io.heads.set("t1--base", "base0");
	io.files.clear();
	io.written = [];
	io.decide.mockReset();
	io.decide.mockImplementation(async () => ({ approve: true, reason: "fine" }));
	ledger.messages = [];
	ledger.entries = [];
	ledger.down = false;
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

	it("cancels an approved gate queued before a veto and ignores its late result", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		await coordinator.submitReview("a", vote("tests", "approve"));
		await coordinator.submitReview("a", vote("api", "approve"));
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1" });
		await coordinator.submitReview("a", vote("security", "reject"));
		expect(fake.env.GATE.getByName("t1").cancel).toHaveBeenCalledWith("t1", "a", "h1");
		expect((await stored()).slices[0].gate).toBeUndefined();
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "stale" });
		expect(io.merges).toEqual([]);
		expect(io.pushes).toBe(0);
	});

	it("cancels a running solo gate after a veto and does not integrate its result", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("queued"), reviews: approvedReviews() }), slice("b")] }));
		await coordinator.gatePlan("a", "h1");
		await coordinator.submitReview("a", vote("security", "reject"));
		expect(fake.env.GATE.getByName("t1").cancel).toHaveBeenCalledWith("t1", "a", "h1");
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "stale" });
		expect(io.merges).toEqual([]);
		expect(io.pushes).toBe(0);
	});

	it("cancels a running group gate when any member is vetoed", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("queued", head), group: [other] });
		const members = [{ slice: "b", head: "hb" }];
		await setup(task({ slices: [
			slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }),
			slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") }),
		] }));
		await coordinator.gatePlan("a", "h1", members);
		await coordinator.submitReview("b", vote("security", "reject", "hb"));
		expect(fake.env.GATE.getByName("t1").cancel).toHaveBeenCalledWith("t1", "b", "hb");
		expect((await stored()).slices.map((slice) => slice.gate)).toEqual([undefined, undefined]);
		expect(await coordinator.gateResult("a", result(), [], members)).toEqual({ outcome: "stale" });
		expect(io.merges).toEqual([]);
		expect(io.pushes).toBe(0);
	});

	it("refuses to start a gate when the latest quorum includes a veto", async () => {
		const vetoed = [...approvedReviews(), { ...vote("security", "reject"), at: "" }];
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("queued"), reviews: vetoed }), slice("b")] }));
		expect(await coordinator.gatePlan("a", "h1")).toBeNull();
		expect((await stored()).slices[0].gate?.status).toBe("queued");
	});

	it("rejects a group result if any member no longer has an approved quorum", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("running", head), group: [other] });
		const bReviews = [...approvedReviews("hb"), { ...vote("security", "reject", "hb"), at: "" }];
		const members = [{ slice: "b", head: "hb" }];
		await setup(task({ slices: [
			slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }),
			slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: bReviews }),
		] }));
		expect(await coordinator.gateResult("a", result(), [], members)).toEqual({ outcome: "stale" });
		expect(io.merges).toEqual([]);
		expect(io.pushes).toBe(0);
	});

	it("plans a run against the current base and marks it running", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("queued"), reviews: approvedReviews() }), slice("b")] }));
		const plan = await coordinator.gatePlan("a", "h1");
		expect(plan).toMatchObject({ baseHead: "base0", checks: ["npm test"], base: { token: "token-t1--base" } });
		expect((await stored()).slices[0].gate?.status).toBe("running");
		expect(await coordinator.gatePlan("a", "stale")).toBeNull();
	});

	it("integrates on a pass and re-queues gates that were waiting", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b", { reviewHead: "hb", gate: gated("waiting", "hb"), reviews: approvedReviews("hb") })] }));
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "passed" });
		const t = await stored();
		expect(t.slices[0].status).toBe("integrated");
		expect(t.slices[1].gate?.status).toBe("queued");
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "b", head: "hb" });
	});

	it("waits on a failure while other slices can still integrate", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b")] }));
		expect(await coordinator.gateResult("a", result({ passed: false }), [])).toEqual({ outcome: "waiting" });
		expect(builder("a").revise).not.toHaveBeenCalled();
	});

	it("sends back on a failure when nothing else can integrate and nothing waits on it", async () => {
		const failure = result({ passed: false, results: [{ command: "npm run typecheck", exitCode: 2, output: "TS2305" }] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b", { status: "integrated" })] }));
		expect(await coordinator.gateResult("a", failure, [])).toEqual({ outcome: "failed" });
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/npm run typecheck \(exit code 2\)\nTS2305/);
	});

	it("merges slices that wait on each other into one group gate", async () => {
		const failure = result({ passed: false, results: [{ command: "npm run typecheck", exitCode: 2, output: "Cannot find module './b'" }] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b", { reviewHead: "hb", gate: gated("waiting", "hb"), reviews: approvedReviews("hb") })] }));
		expect(await coordinator.gateResult("a", failure, [])).toEqual({ outcome: "queued" });
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] });
		const t = await stored();
		expect(t.slices.map((s) => [s.gate?.status, s.gate?.group])).toEqual([["queued", ["b"]], ["queued", ["a"]]]);
		expect(builder("a").revise).not.toHaveBeenCalled();
		expect(builder("b").revise).not.toHaveBeenCalled();
	});

	it("plans and integrates a group run as a whole", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("queued", head), group: [other] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }), slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") })] }));
		const plan = await coordinator.gatePlan("a", "h1", [{ slice: "b", head: "hb" }]);
		expect(plan?.others).toEqual([{ slice: "b", head: "hb", remote: "https://git.test/t1--b.git", token: "token-t1--b" }]);
		expect(await coordinator.gateResult("a", result(), [], [{ slice: "b", head: "hb" }])).toEqual({ outcome: "passed" });
		expect(io.merges).toEqual(["refs/remotes/a/main", "refs/remotes/b/main"]);
		expect(io.pushes).toBe(1); // one push: the base gets the whole group at once
		expect((await stored()).slices.map((s) => s.status)).toEqual(["integrated", "integrated"]);
	});

	it("integrates none of a group when one of its slices conflicts with the base", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("running", head), group: [other] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }), slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") })] }));
		io.heads.set("t1--a", "h1");
		io.heads.set("t1--b", "hb");
		io.mergeConflict = ["src/shared.ts"];
		io.conflictOn = "refs/remotes/b/main";
		await coordinator.gateResult("a", result(), [], [{ slice: "b", head: "hb" }]);
		expect(io.pushes).toBe(0);
		const t = await stored();
		expect(t.slices.map((s) => [s.status, s.gate?.status])).toEqual([
			["building", "waiting"],
			["building", undefined],
		]);
		expect(builder("b").revise.mock.calls[0][0]).toMatch(/conflicts with work already integrated.*src\/shared\.ts/s);
		expect(builder("a").revise).not.toHaveBeenCalled();
	});

	it("retries a slice's gate together with its group", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("queued", head), group: [other] });
		await setup(
			task({
				slices: [
					slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }),
					slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") }),
				],
			}),
		);
		await coordinator.retryGate("a", person);
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] });
		expect(ledger.entries.map((e) => e.text)).toContain("a: gate re-run requested by human@example.com");
	});

	it("refuses to retry while a run for the slice or its group is queued or running", async () => {
		const approved = approvedReviews();
		const grouped = (head: string, other: string) => ({ ...gated("queued", head), group: [other] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approved }), slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") })] }));
		fake.gateQueue.push({ id: "q1", slice: "b", head: "hb" });
		await expect(coordinator.retryGate("a", person)).rejects.toThrow(/already queued/);
		fake.gateQueue.length = 0;
		fake.gateCurrent.item = { id: "r1", slice: "a", head: "h1", group: [{ slice: "b", head: "hb" }] };
		await expect(coordinator.retryGate("a", person)).rejects.toThrow(/already running/);
		// A record left "queued" by a run the Gate no longer holds can be retried.
		fake.gateCurrent.item = null;
		await coordinator.retryGate("a", person);
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledOnce();
	});

	it("sends every slice of a failed group run back, naming the others", async () => {
		const grouped = (head: string, other: string) => ({ ...gated("running", head), group: [other] });
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: grouped("h1", "b"), reviews: approvedReviews() }), slice("b", { reviewHead: "hb", gate: grouped("hb", "a"), reviews: approvedReviews("hb") })] }));
		await coordinator.gateResult("a", result({ passed: false }), [], [{ slice: "b", head: "hb" }]);
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/depends on \(or is depended on by\) b/);
		expect(builder("b").revise.mock.calls[0][0]).toMatch(/depends on \(or is depended on by\) a/);
	});

	it("re-queues a result checked against a base that has since moved", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b")] }));
		io.heads.set("t1--base", "base1");
		expect(await coordinator.gateResult("a", result(), [])).toEqual({ outcome: "rerun" });
		expect((await stored()).slices[0].status).toBe("building");
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledOnce();
	});

	it("sends back a slice that no longer merges onto the base", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: gated("running"), reviews: approvedReviews() }), slice("b")] }));
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
		await expect(coordinator.waive("a", { reason: "reviewers asked for out-of-lane tests" }, person)).rejects.toThrow(/still working/);

		fake.agentStatus.set("t1--a", "done");
		const s = await coordinator.waive("a", { reason: "reviewers asked for out-of-lane tests" }, person);
		expect(s.waivers).toEqual([expect.objectContaining({ head: "h1", by: "human@example.com" })]);
		expect(ledger.entries.map((e) => e.text)).toContain("a: quorum waived by human@example.com: reviewers asked for out-of-lane tests");
		expect(s.attention).toBeUndefined();
		expect(fake.env.GATE.getByName("t1").enqueue).toHaveBeenCalledWith("t1", { slice: "a", head: "h1" });
	});

	it("delivers a message to a running builder's inbox, or resumes a stopped one", async () => {
		await setup(task());
		fake.agentStatus.set("t1--a", "working");
		expect(await coordinator.messageBuilder("a", "use the contract", person)).toEqual({ delivered: "inbox" });
		expect(builder("a").revise).not.toHaveBeenCalled();
		const inboxMessage = builder("a").notify.mock.calls[0][0];
		expect(inboxMessage).toBe("Message from a human on the team: use the contract");
		expect(inboxMessage).not.toContain(person.value);
		expect(ledger.entries.at(-1)?.text).toContain("Message from human@example.com to a's builder (delivered): use the contract");

		fake.agentStatus.set("t1--a", "failed");
		expect(await coordinator.messageBuilder("a", "use the contract", person)).toEqual({ delivered: "resumed" });
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/^Message from a human on the team: use the contract/);
		expect((await stored()).active.builders).toContain("a");
		const modelMessage = builder("a").revise.mock.calls[0][0];
		expect(modelMessage).toBe("Message from a human on the team: use the contract");
		expect(modelMessage).not.toContain(person.value);
		expect(ledger.entries.at(-1)?.text).toContain("human@example.com");
		expect(ledger.entries.at(-1)?.text).toContain("Message from human@example.com to a's builder (resumed it): use the contract");
	});
});

describe("the record in Git", () => {
	const approved = (head = "h1") => [vote("tests", "approve", head), vote("api", "approve", head)];

	it("attributes human approval in the blueprint ledger note", async () => {
		await setup(task({ phase: "awaiting-approval" }));
		await coordinator.approve(person);
		expect(ledger.entries.map((e) => e.text)).toContain("Blueprint approved by human@example.com: contracts committed to t1--base; slices forked: t1--a, t1--b");
	});

	it("attributes a requested gate retry and landing, including service-token identity", async () => {
		const approvedReviews = [{ ...vote("tests", "approve"), at: "" }, { ...vote("api", "approve"), at: "" }];
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: { status: "queued", head: "h1", baseHead: "base0", at: "", excluded: [] }, reviews: approvedReviews }), slice("b")] }));
		await coordinator.retryGate("a", service);
		expect(ledger.entries.map((e) => e.text)).toContain("a: gate re-run requested by service token deploy-script");

		await setup(task({ slices: [slice("a", { status: "integrated" }), slice("b", { status: "integrated" })] }));
		await coordinator.land(service);
		expect((await stored()).phase).toBe("landed");
		expect(ledger.entries.map((e) => e.text)).toContain("Task landed in project by service token deploy-script");
	});

	it("notes each vote and the integration on the reviewed commit, and rebuilds the same state", async () => {
		await setup(task({ verify: [], slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		io.heads.set("t1--a", "h1");
		for (const v of approved()) await coordinator.submitReview("a", v);
		expect(ledger.entries.filter((e) => e.commit === "h1").map((e) => e.text)).toEqual([
			"a: tests reviewer approved: tests says approve",
			"a: api reviewer approved: api says approve",
			"a: quorum approved",
			"a integrated into the task base",
		]);
		expect(await coordinator.ledger()).toMatchObject({ matches: true, commits: 2 });
	});

	it("records nothing for a method that failed", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" })] }));
		await expect(coordinator.submitReview("a", vote("tests", "approve", "old"))).rejects.toThrow(/head under review/);
		expect(ledger.entries).toEqual([]);
	});

	it("keeps decisions while Git is unreachable and writes them with the next change", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		io.heads.set("t1--a", "h1");
		ledger.down = true;
		await coordinator.submitReview("a", vote("security", "approve"));
		expect(ledger.messages).toEqual([]);
		ledger.down = false;
		await coordinator.flagSlice("b", "stuck");
		expect(ledger.entries.map((e) => e.text)).toEqual(["a: security reviewer approved: security says approve", "b needs a human: stuck"]);
		expect(await coordinator.ledger()).toMatchObject({ matches: true });
	});

	it("restores a task from its record into an empty Coordinator", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")], queue: [{ kind: "builder", slice: "b" }] }));
		await coordinator.submitReview("a", vote("security", "reject"));
		const original = await stored();

		const restored = new Coordinator({ storage: new FakeStorage() } as never, fake.env as never);
		const { task: t } = await restored.restore("t1", original.repo);
		expect(t).toEqual({ ...original, queue: [], active: { builders: [], reviewers: [] } });
		await expect(restored.restore("t1", original.repo)).rejects.toThrow(/task exists/);
	});
});

describe("contract amendments", () => {
	const routes = { id: "v-routes-1", text: "routes v1" };
	const propose = (slice: string, content: string, basedOn: string | null, path = "src/routes.ts") =>
		coordinator.proposeAmendment(slice, { path, content, reason: `${slice} needs a route`, basedOn });

	it("brings a shared project file outside every lane under contract", async () => {
		await setup(task());
		io.files.set("src/routes.ts", routes);
		const a = await propose("a", "routes v1 + a", routes.id);
		expect(a).toMatchObject({ status: "approved", kind: "shared", commit: "amend-commit" });
		expect(io.written).toEqual([{ "src/routes.ts": "routes v1 + a" }]);
		expect((await stored()).contracts).toEqual(["src/routes.ts"]);
		expect(builder("b").notify.mock.calls[0][0]).toMatch(/changed and brought under contract/);
	});

	it("refuses a proposal written against an older version without asking the contract owner", async () => {
		await setup(task());
		io.files.set("src/routes.ts", routes);
		const a = await propose("a", "routes v0 + a", "v-routes-0");
		expect(a.status).toBe("stale");
		expect(a.decision).toMatch(/merge base\/main, then propose again/);
		expect(io.decide).not.toHaveBeenCalled();
		expect(io.written).toEqual([]);
	});

	it("doesn't apply an approval if the file changed while the owner decided", async () => {
		await setup(task());
		io.files.set("src/routes.ts", routes);
		io.decide.mockImplementation(async () => {
			io.files.set("src/routes.ts", { id: "v-routes-2", text: "routes v1 + b" }); // b's change lands meanwhile
			return { approve: true, reason: "fine" };
		});
		const a = await propose("a", "routes v1 + a", routes.id);
		expect(a.status).toBe("stale");
		expect(io.written).toEqual([]);
		expect((await stored()).contracts).toEqual([]);
	});

	it("lets two slices change the same shared file one after the other", async () => {
		await setup(task());
		io.files.set("src/routes.ts", routes);
		expect((await propose("a", "routes v1 + a", routes.id)).status).toBe("approved");
		// b wrote its proposal against v1 too: refused, then re-proposed on top of a's change.
		expect((await propose("b", "routes v1 + b", routes.id)).status).toBe("stale");
		const current = io.files.get("src/routes.ts")!;
		expect((await propose("b", "routes v1 + a + b", current.id)).status).toBe("approved");
		expect(io.files.get("src/routes.ts")!.text).toBe("routes v1 + a + b");
		expect((await stored()).amendments!.map((x) => [x.slice, x.kind, x.status])).toEqual([
			["a", "shared", "approved"],
			["b", "contract", "stale"],
			["b", "contract", "approved"],
		]);
	});

	it("refuses a file inside a slice's lane", async () => {
		await setup(task());
		await expect(propose("a", "x", null, "src/b/index.ts")).rejects.toThrow(/inside b's lane/);
	});
});

describe("open mode", () => {
	const openTask = (slices: Slice[] = []) =>
		task({ mode: "open", repo: "project", baseRepo: "project", baseCommit: "main0", anchor: "main0", leaseMinutes: 30, verify: [], slices });
	const open = (title: string, owns: string[]) => coordinator.openChange({ title, intent: `${title}, please`, owns });

	beforeEach(() => {
		io.defaultHead = "main0";
	});

	it("opens a change on free paths, forks the project for it and returns credentials", async () => {
		await setup(openTask());
		const { change, credentials } = await open("Add stats", ["src/stats/"]);
		expect(change).toMatchObject({ status: "building", owns: ["src/stats/"], startCommit: "main0", intent: "Add stats, please" });
		expect(credentials.remote).toBe(`https://git.test/t1--${change.id}.git`);
		expect(Date.parse(change.leaseUntil!)).toBeGreaterThan(Date.now());
		expect(ledger.entries.at(-1)?.text).toMatch(/opened.*claiming src\/stats\//);
	});

	it("refuses a claim that overlaps an active change, naming the holder and its intent", async () => {
		await setup(openTask());
		const { change } = await open("Add stats", ["src/stats/"]);
		await expect(open("Tweak stats", ["src/stats/index.ts"])).rejects.toThrow(new RegExp(`held by change ${change.id} \\("Add stats"\\): Add stats, please`));
		expect((await stored()).slices).toHaveLength(1);
	});

	it("matches whole path segments, so a shared prefix is not an overlap", async () => {
		await setup(openTask());
		await open("Stats", ["src/stats"]);
		await expect(open("Extra", ["src/stats-extra.ts"])).resolves.toBeTruthy();
		await expect(open("Inside", ["src/stats/a.ts"])).rejects.toThrow(/already claimed/);
	});

	it("frees a claim when its change is abandoned or integrated", async () => {
		await setup(openTask([slice("old", { status: "integrated", owns: ["src/done/"] })]));
		await expect(open("Reuse", ["src/done/"])).resolves.toBeTruthy();
		const { change } = await open("First", ["src/x/"]);
		await coordinator.abandonChange(change.id, "changed my mind");
		expect((await stored()).slices.find((s) => s.id === change.id)?.status).toBe("abandoned");
		await expect(open("Second", ["src/x/"])).resolves.toBeTruthy();
	});

	it("extends a claim only to paths no other change holds", async () => {
		await setup(openTask());
		const a = (await open("A", ["src/a/"])).change;
		await open("B", ["src/b/"]);
		await expect(coordinator.extendClaim(a.id, ["src/b/c.ts"])).rejects.toThrow(/already claimed/);
		const extended = await coordinator.extendClaim(a.id, ["src/c/", "src/a/inner.ts"]);
		expect(extended.owns).toEqual(["src/a/", "src/c/"]);
	});

	it("expires an idle claim but renews one that is waiting on review", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		await setup(
			openTask([
				slice("idle", { leaseUntil: past, startCommit: "main0" }),
				slice("reviewing", { leaseUntil: past, startCommit: "main0", reviewHead: "h9" }),
			]),
		);
		await coordinator.alarm();
		const [idle, reviewing] = (await stored()).slices;
		expect(idle.status).toBe("abandoned");
		expect(reviewing.status).toBe("building");
		expect(Date.parse(reviewing.leaseUntil!)).toBeGreaterThan(Date.now());
		expect(storage.alarm).not.toBeNull();
	});

	it("refuses landing and contract amendments in open mode", async () => {
		await setup(openTask([slice("a", { startCommit: "main0" })]));
		await expect(coordinator.land(person)).rejects.toThrow(/nothing to land/);
		await expect(coordinator.proposeAmendment("a", { path: "src/shared.ts", content: "x", reason: "r", basedOn: null })).rejects.toThrow(/open mode has no contracts/);
	});

	it("only opens changes on an open-mode task", async () => {
		await setup(task());
		await expect(open("A", ["src/a/"])).rejects.toThrow(/open-mode task/);
	});
});
