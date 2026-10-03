import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";
import type { LaneChangeCoordinator, LaneChangeRequestInput } from "../../src/lane-change-contract";

const io = vi.hoisted(() => ({
	heads: new Map<string, string>(),
	merges: [] as string[],
	answerCommitIncluded: true,
}));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/git", () => ({
	Workspace: { clone: vi.fn(async () => ({
		fetch: vi.fn(async () => "fetched"),
		merge: vi.fn(async (ref: string) => { io.merges.push(ref); }),
		mergeBase: vi.fn(async (commit: string) => io.answerCommitIncluded ? commit : "common"),
		push: vi.fn(async () => { io.heads.set("t1--base", "integrated-head"); }),
	})) },
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));
const { Coordinator } = await import("../../src/coordinator");

let fake: ReturnType<typeof fakeEnv>;
let coordinator: InstanceType<typeof Coordinator>;
let storage: FakeStorage;
const laneCoordinator = () => coordinator as unknown as LaneChangeCoordinator;
const request: LaneChangeRequestInput = { path: "src/b/routes.ts", need: "Add the new route registration.", reason: "Slice a needs this endpoint to call its API." };
const approved = (head: string) => [
	{ reviewer: "tests", head, verdict: "approve" as const, summary: "ok", at: "" },
	{ reviewer: "api", head, verdict: "approve" as const, summary: "ok", at: "" },
];

async function setup(overrides: Parameters<typeof task>[0] = {}) {
	storage = new FakeStorage();
	fake = fakeEnv();
	io.heads.clear(); io.heads.set("t1--base", "base0"); io.heads.set("t1--b", "owner-head");
	io.merges = [];
	io.answerCommitIncluded = true;
	await storage.put("task", task({
		slices: [slice("a"), slice("b")],
		laneChangeRequests: [],
		active: { builders: ["a", "b"], reviewers: [] },
		verify: [],
		...overrides,
	}));
	coordinator = new Coordinator({ storage } as never, fake.env as never);
}
const saved = async () => (await storage.get<ReturnType<typeof task>>("task"))!;

async function makeRequest() {
	const created = await laneCoordinator().requestLaneChange("a", request);
	if (created.outcome !== "requested") throw new Error("expected request to be delivered");
	return created.request;
}

describe("cross-lane request lifecycle", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("delivers a request to its owning slice and records the pending request", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "working");
		const result = await laneCoordinator().requestLaneChange("a", request);
		expect(result).toMatchObject({ outcome: "requested", delivery: "inbox" });
		const state = await saved();
		expect(state.laneChangeRequests).toHaveLength(1);
		expect(state.laneChangeRequests![0]).toMatchObject({ requester: "a", owner: "b", path: request.path, status: "pending" });
		expect(fake.env.BUILDER.getByName("t1--b").notify).toHaveBeenCalledWith(expect.stringContaining("Slice a"));
		expect(fake.env.BUILDER.getByName("t1--b").notify.mock.calls[0][0]).not.toContain("human@example.com");
	});

	it("puts a request in the running builder's inbox", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "working");
		const result = await laneCoordinator().requestLaneChange("a", request);
		expect(result.outcome).toBe("requested");
		expect(fake.env.BUILDER.getByName("t1--b").notify).toHaveBeenCalledOnce();
		expect(fake.env.BUILDER.getByName("t1--b").revise).not.toHaveBeenCalled();
	});

	it("resumes a finished owner builder with the request and fresh credentials", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "done");
		const result = await laneCoordinator().requestLaneChange("a", request);
		expect(result).toMatchObject({ outcome: "requested", delivery: "resumed" });
		expect(fake.env.BUILDER.getByName("t1--b").revise).toHaveBeenCalledWith(expect.stringContaining("request"), expect.objectContaining({ token: "token-t1--b" }));
	});

	it("records a human outcome instead of delivering to an already integrated owner", async () => {
		await setup({ slices: [slice("a"), slice("b", { status: "integrated" })] });
		const result = await laneCoordinator().requestLaneChange("a", request);
		expect(result.outcome).toBe("human");
		expect((await saved()).laneChangeRequests![0].status).toBe("human");
		expect((await saved()).slices[0].attention).toMatch(/already integrated|human/i);
		expect(fake.env.BUILDER.getByName("t1--b").notify).not.toHaveBeenCalled();
	});

	it("directs a path in no lane to the existing amendment path without creating a request", async () => {
		await setup();
		const result = await laneCoordinator().requestLaneChange("a", { ...request, path: "docs/README.md" });
		expect(result).toMatchObject({ outcome: "no-owner" });
		expect(result.message).toMatch(/propose_contract_change|amendment/i);
		expect((await saved()).laneChangeRequests).toEqual([]);
	});

	it("tracks the explicitly answered commit and integrates only when that commit is included", async () => {
		await setup({ slices: [slice("a"), slice("b", { reviewHead: "owner-head", reviews: approved("owner-head") })] });
		fake.agentStatus.set("t1--b", "working");
		fake.agentStatus.set("t1--a", "done");
		const request = await makeRequest();
		const answered = await laneCoordinator().answerLaneChange("b", request.id, { outcome: "done", answer: "Implemented in the owner commit.", commit: "change-commit" });
		expect(answered).toMatchObject({ status: "answered", answerCommit: "change-commit" });
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ answerCommit: "change-commit" });
		io.answerCommitIncluded = true;
		await coordinator.integrate("b");
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ id: request.id, status: "integrated" });
		expect(fake.env.BUILDER.getByName("t1--a").revise).toHaveBeenCalledWith(expect.stringMatching(/integrated.*fetch_base|fetch_base.*integrated/is), expect.anything());
	});

	it("flags the requester for a human when the owner integrates without the answered commit", async () => {
		await setup({ slices: [slice("a"), slice("b", { reviewHead: "owner-head", reviews: approved("owner-head") })] });
		fake.agentStatus.set("t1--b", "working");
		const request = await makeRequest();
		await laneCoordinator().answerLaneChange("b", request.id, { outcome: "done", answer: "Implemented in the owner commit.", commit: "change-commit" });
		io.answerCommitIncluded = false;
		await coordinator.integrate("b");
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ id: request.id, status: "human" });
		expect((await saved()).slices[0].attention).toMatch(/human|integrated/i);
	});

	it("records a declined request, tells the requester, and flags it for a human", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "working");
		fake.agentStatus.set("t1--a", "working");
		const request = await makeRequest();
		await laneCoordinator().answerLaneChange("b", request.id, { outcome: "declined", answer: "This route belongs to a separate service and cannot be added here." });
		const state = await saved();
		expect(state.laneChangeRequests![0]).toMatchObject({ status: "declined", answer: expect.stringContaining("cannot be added") });
		expect(state.slices[0].attention).toMatch(/human/i);
		expect(fake.env.BUILDER.getByName("t1--a").notify).toHaveBeenCalledWith(expect.stringContaining("cannot be added"));
	});
});
