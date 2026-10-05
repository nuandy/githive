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
	/** Files each pushed head changed, for Merge-ahead: what changedPaths reports. */
	touched: new Map<string, string[]>(),
	/** Forks Merge-ahead fetched, by name. */
	fetched: [] as string[],
	/** Runs once when Merge-ahead next fetches a fork, to simulate something happening mid-check. */
	onFetch: null as null | (() => Promise<void>),
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
			head: vi.fn(async () => io.heads.get("project") ?? io.defaultHead),
			fetch: vi.fn(async (_name: string, remote: { url: string }) => {
				io.fetched.push(_name);
				const hook = io.onFetch;
				io.onFetch = null;
				await hook?.();
				return io.heads.get(remote.url.replace(/^https:\/\/git\.test\/|\.git$/g, "")) ?? "fetched";
			}),
			mergeBase: vi.fn(async () => "main0"),
			changedPaths: vi.fn(async (_from: string, head: string) => io.touched.get(head) ?? []),
			tryMerge: vi.fn(async () => ({ clean: true, files: [] })),
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
const ledger = vi.hoisted(() => ({ messages: [] as string[], entries: [] as { commit: string; text: string }[], down: false, readDelayMs: 0, writeDelayMs: 0 }));

vi.mock("../src/ledger-git", async () => {
	const { ledgerMessage } = await import("../src/ledger");
	return {
		appendLedger: vi.fn(async (_remote: unknown, _taskId: string, entries: { commit: string; text: string; at: string }[], patch: never) => {
			if (ledger.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, ledger.writeDelayMs));
			if (ledger.down) throw new Error("git is down");
			ledger.messages.push(ledgerMessage(entries, patch));
			ledger.entries.push(...entries);
		}),
		readLedger: vi.fn(async () => {
			if (ledger.readDelayMs) await new Promise((resolve) => setTimeout(resolve, ledger.readDelayMs));
			return [...ledger.messages];
		}),
	};
});

const { Coordinator } = await import("../src/coordinator");
const artifacts = await import("../src/artifacts");

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
	ledger.readDelayMs = 0;
	ledger.writeDelayMs = 0;
	io.touched.clear();
	io.onFetch = null;
	io.fetched = [];
});

describe("limits and queues", () => {
	it("starts builders up to the limit, queues the rest, and starts the next when one stops", async () => {
		io.defaultHead = "main0";
		await setup(task({ mode: "open", baseRepo: "project", slices: [], limits: { builders: 2, reviewers: 6 } }));
		// Hosted changes: each gets a builder, as many at once as the limit allows.
		for (const id of ["a", "b", "c"]) await coordinator.openChange({ id, title: id, intent: `build ${id}`, owns: [`src/${id}/`], hosted: true });
		expect(builder("a").start).toHaveBeenCalledOnce();
		expect(builder("b").start).toHaveBeenCalledOnce();
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
		await coordinator.ledgerIdle();
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

	it("reports a reviewer that could not start and flags the slice", async () => {
		await setup(task());
		vi.mocked(fake.env.REVIEWER.getByName("t1--a--review-tests--h1").start).mockRejectedValue(new Error("[503] no containers"));
		const { reviewers, failed, escalated } = await coordinator.startReviewers("a", "built it");
		expect(escalated).toBe(false);
		expect(reviewers).toEqual(["security", "tests", "api"]);
		expect(failed).toEqual(["Could not start reviewer a:tests:h1: no containers"]);
		const t = await stored();
		expect(t.slices[0].attention).toBe("Could not start reviewer a:tests:h1: no containers");
		expect(t.active.reviewers).toEqual(["a:security:h1", "a:api:h1"]);
		await coordinator.ledgerIdle();
		expect(ledger.entries.map((e) => e.text)).toContain("a needs a human: Could not start reviewer a:tests:h1: no containers");
	});

	it("reports no failures when every reviewer starts", async () => {
		await setup(task());
		expect((await coordinator.startReviewers("a", "built it")).failed).toEqual([]);
	});

	it("refuses a waiver while the builder is working, then records it and queues the gate", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1", attention: "stuck" }), slice("b")] }));
		fake.agentStatus.set("t1--a", "working");
		await expect(coordinator.waive("a", { reason: "reviewers asked for out-of-lane tests" }, person)).rejects.toThrow(/still working/);

		fake.agentStatus.set("t1--a", "done");
		const s = await coordinator.waive("a", { reason: "reviewers asked for out-of-lane tests" }, person);
		expect(s.waivers).toEqual([expect.objectContaining({ head: "h1", by: "human@example.com" })]);
		await coordinator.ledgerIdle();
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
		await coordinator.ledgerIdle();
		expect(ledger.entries.at(-1)?.text).toContain("Message from human@example.com to a's builder (delivered): use the contract");

		fake.agentStatus.set("t1--a", "failed");
		expect(await coordinator.messageBuilder("a", "use the contract", person)).toEqual({ delivered: "resumed" });
		expect(builder("a").revise.mock.calls[0][0]).toMatch(/^Message from a human on the team: use the contract/);
		expect((await stored()).active.builders).toContain("a");
		const modelMessage = builder("a").revise.mock.calls[0][0];
		expect(modelMessage).toBe("Message from a human on the team: use the contract");
		expect(modelMessage).not.toContain(person.value);
		await coordinator.ledgerIdle();
		expect(ledger.entries.at(-1)?.text).toContain("human@example.com");
		await coordinator.ledgerIdle();
		expect(ledger.entries.at(-1)?.text).toContain("Message from human@example.com to a's builder (resumed it): use the contract");
	});
});

describe("the record in Git", () => {
	const approved = (head = "h1") => [vote("tests", "approve", head), vote("api", "approve", head)];

	it("attributes a requested gate retry, including service-token identity", async () => {
		const approvedReviews = [{ ...vote("tests", "approve"), at: "" }, { ...vote("api", "approve"), at: "" }];
		await setup(task({ slices: [slice("a", { reviewHead: "h1", gate: { status: "queued", head: "h1", baseHead: "base0", at: "", excluded: [] }, reviews: approvedReviews }), slice("b")] }));
		await coordinator.retryGate("a", service);
		await coordinator.ledgerIdle();
		expect(ledger.entries.map((e) => e.text)).toContain("a: gate re-run requested by service token deploy-script");
	});

	it("notes each vote and the integration on the reviewed commit, and rebuilds the same state", async () => {
		await setup(task({ verify: [], slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		io.heads.set("t1--a", "h1");
		for (const v of approved()) await coordinator.submitReview("a", v);
		await coordinator.ledgerIdle();
		expect(ledger.entries.filter((e) => e.commit === "h1").map((e) => e.text)).toEqual([
			"a: tests reviewer approved: tests says approve",
			"a: api reviewer approved: api says approve",
			"a: quorum approved",
			"a merged into main",
		]);
		expect(await coordinator.ledger()).toMatchObject({ matches: true, commits: 2 });
	});

	it("records nothing for a method that failed", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" })] }));
		await expect(coordinator.submitReview("a", vote("tests", "approve", "old"))).rejects.toThrow(/head under review/);
		await coordinator.ledgerIdle();
		expect(ledger.entries).toEqual([]);
	});

	it("keeps decisions while Git is unreachable and writes them with the next change", async () => {
		await setup(task({ slices: [slice("a", { reviewHead: "h1" }), slice("b")] }));
		io.heads.set("t1--a", "h1");
		ledger.down = true;
		await coordinator.submitReview("a", vote("security", "approve"));
		await coordinator.ledgerIdle();
		expect(ledger.messages).toEqual([]);
		ledger.down = false;
		await coordinator.flagSlice("b", "stuck");
		await coordinator.ledgerIdle();
		expect(ledger.entries.map((e) => e.text)).toEqual(["a: security reviewer approved: security says approve", "b needs a human: stuck"]);
		expect(await coordinator.ledger()).toMatchObject({ matches: true });
	});

});

describe("lock timings", () => {
	it("records how long each call waited behind the one holding the lock", async () => {
		await setup(task());
		ledger.readDelayMs = 40;
		await Promise.all([coordinator.ledger(), coordinator.ledger()]);
		const { samples, inFlight } = await coordinator.lockStats();
		expect(samples).toHaveLength(2);
		expect(samples[0].runMs).toBeGreaterThanOrEqual(30);
		expect(samples[1].waitMs).toBeGreaterThanOrEqual(30);
		expect(inFlight).toBe(0);
	});

	it("records failed calls and clears samples on reset", async () => {
		await setup(task({ mode: "open" }));
		await expect(coordinator.abandonChange("no-such-change", "gone")).rejects.toThrow();
		expect((await coordinator.lockStats(true)).samples).toHaveLength(1);
		expect((await coordinator.lockStats()).samples).toHaveLength(0);
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
		await coordinator.ledgerIdle();
		expect(ledger.entries.at(-1)?.text).toMatch(/opened.*claiming src\/stats\//);
	});

	// A call can be asked again after an answer was lost (its leader crashed mid-call, say): opening is safe to repeat.
	it("finishes an open that was interrupted after its reservation, when the same change is asked again", async () => {
		const reserved = slice("x-1", { status: "opening", owns: ["src/x/"], repo: "t1--x-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), external: true });
		await setup(openTask([reserved]));
		const { change, credentials } = await coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/x/"] });
		expect(change).toMatchObject({ id: "x-1", status: "building", startCommit: "main0" });
		expect(credentials).toMatchObject({ slice: "x-1", remote: "https://git.test/t1--x-1.git" });
		expect((await stored()).slices.map((s) => [s.id, s.status])).toEqual([["x-1", "building"]]);
	});

	it("answers an open asked again after it went through with the same change and fresh credentials", async () => {
		await setup(openTask());
		const first = await coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/x/"] });
		const again = await coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/x/"] });
		expect(again.change).toMatchObject({ id: "x-1", status: "building", startCommit: first.change.startCommit });
		expect(again.credentials).toMatchObject({ slice: "x-1", remote: first.credentials.remote });
		expect((await stored()).slices).toHaveLength(1);
	});

	it("answers an abandon asked again with the change as it was abandoned", async () => {
		await setup(openTask());
		const { change } = await open("X", ["src/x/"]);
		await coordinator.abandonChange(change.id, "done");
		await coordinator.ledgerIdle();
		const commits = ledger.entries.length;
		expect(await coordinator.abandonChange(change.id, "done")).toMatchObject({ id: change.id, status: "abandoned" });
		await coordinator.ledgerIdle();
		// Nothing new decided: it was already abandoned.
		expect(ledger.entries).toHaveLength(commits);
	});

	it("still refuses the same change id for other paths, or once that change has ended", async () => {
		await setup(openTask());
		await coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/x/"] });
		await expect(coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/y/"] })).rejects.toThrow("change x-1 already exists");
		await coordinator.abandonChange("x-1", "done");
		await expect(coordinator.openChange({ id: "x-1", title: "X", intent: "X, please", owns: ["src/x/"] })).rejects.toThrow("change x-1 already exists");
	});

	it("records when a change opened and who opened it (a person by a hash of their email, never the address), and when it ended", async () => {
		await setup(openTask());
		const byPerson = await coordinator.openChange({ title: "X", intent: "X, please", owns: ["src/x/"] }, { kind: "person", value: "Human@Example.com" });
		expect(byPerson.change.openedBy).toMatch(/^person:[0-9a-f]{12}$/);
		expect(JSON.stringify(byPerson.change)).not.toMatch(/example\.com/i);
		expect(Date.parse(byPerson.change.openedAt!)).toBeGreaterThan(0);
		const byService = await coordinator.openChange({ title: "Y", intent: "Y, please", owns: ["src/y/"] }, { kind: "service", value: "ci-bot" });
		expect(byService.change.openedBy).toBe("service:ci-bot");
		const hosted = await coordinator.openChange({ title: "Z", intent: "Z, please", owns: ["src/z/"], hosted: true });
		expect(hosted.change.openedBy).toBe("blueprint-builder");

		expect(byPerson.change.endedAt).toBeUndefined();
		const abandoned = await coordinator.abandonChange(byPerson.change.id, "done");
		expect(Date.parse(abandoned.endedAt!)).toBeGreaterThanOrEqual(Date.parse(byPerson.change.openedAt!));
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

	it("sends review findings for an external change to its inbox instead of a hosted builder", async () => {
		await setup(openTask([slice("ext", { startCommit: "main0", reviewHead: "h1", external: true })]));
		io.heads.set("t1--ext", "h1");
		await coordinator.submitReview("ext", vote("security", "reject"));
		const ext = (await stored()).slices[0];
		expect(builder("ext").revise).not.toHaveBeenCalled();
		expect(ext.revisions).toBe(1);
		expect(ext.inbox?.at(-1)?.text).toMatch(/security/);
		expect(await coordinator.readInbox("ext")).toHaveLength(1);
	});

});

describe("deleting a task", () => {
	it("refuses while agents are at work", async () => {
		await setup(task({ active: { builders: ["a"], reviewers: [] } }));
		await expect(coordinator.destroy()).rejects.toThrow(/still at work: builder a/);
		expect(await stored()).toBeTruthy();
	});

	it("deletes a task stored before scheduling existed", async () => {
		const { queue: _queue, active: _active, ...old } = task();
		storage = new FakeStorage();
		fake = fakeEnv();
		await storage.put("task", old);
		coordinator = new Coordinator({ storage } as never, fake.env as never);
		expect(await coordinator.destroy()).toEqual({ id: "t1", repo: "project" });
	});

	it("deletes the task's state and alarm, and is harmless to repeat", async () => {
		await setup(task());
		storage.alarm = Date.now() + 60_000;
		expect(await coordinator.destroy()).toEqual({ id: "t1", repo: "project" });
		expect(storage.data.size).toBe(0);
		expect(storage.alarm).toBeNull();
		expect(await coordinator.destroy()).toEqual({ id: null, repo: null });
	});
});

describe("short locks: open mode under concurrency", () => {
	const openTask = (slices: Slice[] = []) =>
		task({ mode: "open", repo: "project", baseRepo: "project", baseCommit: "main0", anchor: "main0", leaseMinutes: 30, verify: [], slices });
	const open = (title: string, owns: string[]) => coordinator.openChange({ title, intent: `${title}, please`, owns });
	const deferred = () => {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => (resolve = r));
		return { promise, resolve };
	};

	beforeEach(() => {
		io.defaultHead = "main0";
	});

	it("holds a claim while the fork is made, without holding the lock", async () => {
		await setup(openTask());
		const forking = deferred();
		const realFork = vi.mocked(artifacts.forkAndWait).getMockImplementation()!;
		vi.mocked(artifacts.forkAndWait).mockImplementationOnce(async (...args) => {
			await forking.promise;
			return realFork(...args);
		});
		const first = open("Add stats", ["src/stats/"]);
		await vi.waitFor(async () => expect((await stored()).slices[0]?.status).toBe("opening"));

		// Other calls go ahead while the first change's fork is still being made.
		await expect(open("Tweak stats", ["src/stats/index.ts"])).rejects.toThrow(/already claimed/);
		await expect(open("Other", ["src/other/"])).resolves.toBeTruthy();
		expect((await coordinator.claims()).map((c) => c.owns)).toEqual([["src/stats/"], ["src/other/"]]);

		forking.resolve();
		const { change } = await first;
		expect(change).toMatchObject({ status: "building", startCommit: "main0" });
		await coordinator.ledgerIdle();
		expect(ledger.entries.filter((e) => e.text.includes("opened"))).toHaveLength(2);
	});

	it("forks at most six at a time, while claims carry on", async () => {
		await setup(openTask());
		const gate = deferred();
		let running = 0;
		let peak = 0;
		const realFork = vi.mocked(artifacts.forkAndWait).getMockImplementation()!;
		vi.mocked(artifacts.forkAndWait).mockImplementation(async (...args) => {
			peak = Math.max(peak, ++running);
			await gate.promise;
			running--;
			return realFork(...args);
		});
		const opening = Array.from({ length: 10 }, (_, i) => open(`c${i}`, [`src/c${i}/`]));
		await vi.waitFor(async () => expect((await coordinator.claims())).toHaveLength(10));
		expect(running).toBe(6);
		await expect(open("Taken", ["src/c9/x.ts"])).rejects.toThrow(/already claimed/);
		gate.resolve();
		await Promise.all(opening);
		expect(peak).toBe(6);
		vi.mocked(artifacts.forkAndWait).mockImplementation(realFork);
	});

	it("frees the claim when the fork fails", async () => {
		await setup(openTask());
		vi.mocked(artifacts.forkAndWait).mockRejectedValueOnce(new Error("artifacts is down"));
		await expect(open("Add stats", ["src/stats/"])).rejects.toThrow(/artifacts is down/);
		expect((await stored()).slices).toEqual([]);
		await expect(open("Add stats", ["src/stats/"])).resolves.toBeTruthy();
	});

	it("drops a reservation whose opener was lost", async () => {
		const past = new Date(Date.now() - 1_000).toISOString();
		await setup(openTask([slice("lost", { status: "opening", leaseUntil: past, head: undefined })]));
		await coordinator.alarm();
		expect((await stored()).slices[0].status).toBe("abandoned");
		await expect(open("Again", ["src/lost/"])).resolves.toBeTruthy();
	});

	it("records a push checked outside the lock", async () => {
		await setup(openTask([slice("a", { startCommit: "main0", head: "main0" })]));
		io.heads.set("t1--a", "h1");
		io.touched.set("h1", ["src/a/x.ts", "README.md"]);
		const { changed } = await coordinator.recordPush("a");
		expect(changed).toBe(true);
		expect((await stored()).slices[0]).toMatchObject({ head: "h1", touched: ["src/a/x.ts", "README.md"], outOfLane: ["README.md"] });
	});

	it("checks a push only against changes that have pushed, without fetching the rest", async () => {
		await setup(
			openTask([
				slice("a", { startCommit: "main0", head: "main0" }),
				slice("idle", { startCommit: "main0", head: "main0" }),
				slice("busy", { startCommit: "main0", head: "b1" }),
			]),
		);
		io.heads.set("t1--a", "h1");
		io.heads.set("t1--busy", "b1");
		io.touched.set("h1", ["src/a/x.ts"]);
		io.touched.set("b1", ["src/busy/y.ts"]);
		const { checks } = await coordinator.recordPush("a");
		expect(io.fetched).toEqual(["a", "busy"]);
		expect(checks.map((c) => c.pair)).toEqual([["a", "busy"]]);
	});

	it("redoes a push check when another push was recorded while it ran", async () => {
		await setup(openTask([slice("a", { startCommit: "main0", head: "main0" })]));
		io.heads.set("t1--a", "h1");
		io.touched.set("h1", ["src/a/one.ts"]);
		io.touched.set("h2", ["src/a/one.ts", "src/a/two.ts"]);
		// While the first check runs, the agent pushes again and that push is recorded first.
		io.onFetch = async () => {
			io.heads.set("t1--a", "h2");
			await coordinator.recordPush("a");
		};
		await coordinator.recordPush("a");
		expect((await stored()).slices[0]).toMatchObject({ head: "h2", touched: ["src/a/one.ts", "src/a/two.ts"] });
	});

	it("writes a burst of decisions to Git in fewer commits, in order", async () => {
		await setup(openTask());
		ledger.writeDelayMs = 20;
		const opened = await Promise.all(["a", "b", "c", "d"].map((name) => open(name, [`src/${name}/`])));
		expect(await coordinator.ledgerIdle()).toBe(0);
		const texts = ledger.entries.map((e) => e.text).filter((t) => t.includes("opened"));
		expect(texts).toHaveLength(4);
		expect(ledger.messages.length).toBeLessThan(5);
		expect(new Set(opened.map((o) => o.change.id)).size).toBe(4);
		expect(await coordinator.ledger()).toMatchObject({ matches: true });
	});

	it("frees an abandoned change's lane before its agents are stopped", async () => {
		await setup(openTask([slice("a", { startCommit: "main0" })]));
		const stopping = deferred();
		builder("a").cancel.mockImplementationOnce(async () => {
			await stopping.promise;
			return true;
		});
		const abandoning = coordinator.abandonChange("a", "done");
		await vi.waitFor(async () => expect((await stored()).slices[0].status).toBe("abandoned"));
		await expect(open("Reuse", ["src/a/"])).resolves.toBeTruthy();
		stopping.resolve();
		await abandoning;
		expect(builder("a").cancel).toHaveBeenCalled();
	});
});

describe("parking: delivery and timeout", () => {
	const request = { id: "r1", requester: "a", owner: "b", path: "src/b/x.ts", need: "add x", reason: "a needs x", status: "pending" as const, createdAt: "" };
	const parked = (extra: Partial<Slice> = {}) => slice("a", { parkedAt: "2026-10-04T00:00:00.000Z", parkedWaitingFor: ["r1"], ...extra });
	const withRequests = (slices: Slice[]) => ({ ...task({ slices }), laneChangeRequests: [{ ...request }] }) as Task;

	it("keeps a wake event whose delivery failed and delivers it exactly once on retry", async () => {
		await setup(withRequests([parked(), slice("b")]));
		builder("a").wake.mockRejectedValueOnce(new Error("[400] builder busy"));
		await coordinator.answerLaneChange("b", "r1", { outcome: "declined", answer: "cannot be added" });
		let a = (await stored()).slices[0];
		expect(a.wakeOutbox).toHaveLength(1);
		expect(a.parkedAt).toBeDefined();
		expect((await stored()).queue).toContainEqual({ kind: "builder", slice: "a" });

		await coordinator.agentStopped("builder", "nobody"); // drains the queue
		a = (await stored()).slices[0];
		expect(a.wakeOutbox).toBeUndefined();
		expect(a.parkedAt).toBeUndefined();
		const calls = builder("a").wake.mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0][0]).toBe(calls[1][0]); // the same event id both times
		expect(builder("a").revise).toHaveBeenCalledOnce();
	});

	it("flags a parked timeout once, even when the builder already recorded it, and notes it in Git", async () => {
		await setup(withRequests([parked(), slice("b")]));
		builder("a").markParkTimedOut.mockResolvedValue(false);
		await coordinator.parkedBuilderTimedOut("a", "2026-10-04T00:00:00.000Z");
		await coordinator.parkedBuilderTimedOut("a", "2026-10-04T00:00:00.000Z");
		const a = (await stored()).slices[0];
		expect(a.attention).toMatch(/parked for more than 30 minutes/);
		expect(a.parkTimeoutFlagged).toBe("2026-10-04T00:00:00.000Z");
		await coordinator.ledgerIdle();
		expect(ledger.entries.filter((e) => e.text.includes("parked timeout"))).toHaveLength(1);
	});

	it("puts a resolution for an external change in its inbox instead of waking a builder", async () => {
		await setup(withRequests([slice("a", { external: true }), slice("b")]));
		await coordinator.answerLaneChange("b", "r1", { outcome: "declined", answer: "cannot be added" });
		const a = (await stored()).slices[0];
		expect(builder("a").wake).not.toHaveBeenCalled();
		expect(a.inbox?.at(-1)?.text).toMatch(/declined.*cannot be added/s);
	});

	it("refuses to park while messages are waiting to be delivered", async () => {
		await setup(withRequests([slice("a", { wakeOutbox: [{ eventId: "e1", message: "news" }] }), slice("b")]));
		const result = await coordinator.parkBuilder("a");
		expect(result).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/Messages are waiting/) });
		expect(builder("a").park).not.toHaveBeenCalled();
	});
});

describe("agent jobs and credentials", () => {
	it("starts a hosted change's builder with its change, the other changes and tokens", async () => {
		io.defaultHead = "main0";
		await setup(task({ mode: "open", baseRepo: "project", slices: [slice("b"), slice("c", { status: "abandoned" })] }));
		await coordinator.openChange({ id: "a", title: "a", intent: "build a", owns: ["src/a/"], hosted: true });
		expect(builder("a").start).toHaveBeenCalledWith({
			taskId: "t1",
			goal: "a goal",
			slice: { id: "a", title: "a", owns: ["src/a/"], instructions: "build a", tests: [] },
			siblings: [{ id: "b", title: "b", owns: ["src/b/"] }],
			verify: ["npm test"],
			repo: "t1--a",
			remote: "https://git.test/t1--a.git",
			token: "token-t1--a",
			base: { remote: "https://git.test/project.git", token: "token-project" },
		});
	});

	it("starts a reviewer pinned to the commit under review", async () => {
		io.heads.set("t1--a", "h1");
		await setup(task());
		await coordinator.startReviewers("a", "built it");
		expect(fake.env.REVIEWER.getByName("t1--a--review-tests--h1").start).toHaveBeenCalledWith({
			taskId: "t1",
			goal: "a goal",
			slice: { id: "a", title: "a", owns: ["src/a/"], instructions: "build a", tests: [] },
			siblings: [{ id: "b", title: "b", owns: ["src/b/"] }],
			verify: ["npm test"],
			repo: "t1--a",
			remote: "https://git.test/t1--a.git",
			token: "token-t1--a",
			role: "tests",
			head: "h1",
			baseCommit: "base0",
			buildSummary: "built it",
			revision: 0,
			priorFindings: undefined,
		});
	});

	it("sends a slice back with fresh builder credentials and cancels its reviewers", async () => {
		io.heads.set("t1--a", "h1");
		await setup(task());
		await coordinator.startReviewers("a", "built it");
		await coordinator.submitReview("a", vote("security", "reject"));
		expect(builder("a").revise).toHaveBeenCalledWith(expect.stringContaining("security says reject"), {
			token: "token-t1--a",
			base: { remote: "https://git.test/t1--base.git", token: "token-t1--base" },
		});
		for (const role of ["security", "tests", "api"])
			expect(fake.env.REVIEWER.getByName(`t1--a--review-${role}--h1`).cancel).toHaveBeenCalledWith("the slice was sent back to its builder");
	});

	it("wakes a builder with fresh credentials", async () => {
		await setup(task());
		await coordinator.messageBuilder("a", "hello", person);
		expect(builder("a").wake).toHaveBeenCalledWith(expect.stringMatching(/^human-message:/), "Message from a human on the team: hello", {
			token: "token-t1--a",
			base: { remote: "https://git.test/t1--base.git", token: "token-t1--base" },
		});
	});
});

describe("cross-lane request paths", () => {
	it("refuses paths that are not plain, or not safe to repeat to another agent", async () => {
		await setup(task());
		for (const path of ["/src/b/x.ts", "src//b", "src/b/", "./src/b/x.ts", "src/b/../a/x.ts", " src/b/x.ts", "C:/src/b", "src\\b\\x.ts", "src/b/\u0007x"])
			await expect(coordinator.requestLaneChange("a", { path, need: "n", reason: "r" })).rejects.toThrow(`[400] invalid relative path: ${path}`);
		await expect(coordinator.requestLaneChange("a", { path: "src/b/x.ts", need: "n", reason: "r" })).resolves.toMatchObject({ outcome: "requested" });
	});
});
