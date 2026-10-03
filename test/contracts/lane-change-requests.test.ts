import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";
import type { LaneChangeRequestInput } from "../../src/lane-change-contract";

const io = vi.hoisted(() => ({ heads: new Map<string, string>(), merges: [] as string[] }));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/git", () => ({
	Workspace: { clone: vi.fn(async () => ({
		fetch: vi.fn(async () => "fetched"),
		merge: vi.fn(async (ref: string) => { io.merges.push(ref); }),
		push: vi.fn(async () => undefined),
	})) },
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));
const { Coordinator } = await import("../../src/coordinator");

let fake: ReturnType<typeof fakeEnv>;
let coordinator: InstanceType<typeof Coordinator>;
let storage: FakeStorage;
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

describe("cross-lane request lifecycle", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("delivers a request to its owning slice and records the pending request", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "working");
		const result = await coordinator.requestLaneChange("a", request);
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
		const result = await coordinator.requestLaneChange("a", request);
		expect(result.outcome).toBe("requested");
		expect(fake.env.BUILDER.getByName("t1--b").notify).toHaveBeenCalledOnce();
		expect(fake.env.BUILDER.getByName("t1--b").revise).not.toHaveBeenCalled();
	});

	it("resumes a finished owner builder with the request and fresh credentials", async () => {
		await setup();
		fake.agentStatus.set("t1--b", "done");
		const result = await coordinator.requestLaneChange("a", request);
		expect(result).toMatchObject({ outcome: "requested", delivery: "resumed" });
		expect(fake.env.BUILDER.getByName("t1--b").revise).toHaveBeenCalledWith(expect.stringContaining("request"), expect.objectContaining({ token: "token-t1--b" }));
	});

	it("records a human outcome instead of delivering to an already integrated owner", async () => {
		await setup({ slices: [slice("a"), slice("b", { status: "integrated" })] });
		const result = await coordinator.requestLaneChange("a", request);
		expect(result.outcome).toBe("human");
		expect((await saved()).laneChangeRequests![0].status).toBe("human");
		expect((await saved()).slices[0].attention).toMatch(/already integrated|human/i);
		expect(fake.env.BUILDER.getByName("t1--b").notify).not.toHaveBeenCalled();
	});

	it("directs a path in no lane to the existing amendment path without creating a request", async () => {
		await setup();
		const result = await coordinator.requestLaneChange("a", { ...request, path: "docs/README.md" });
		expect(result).toMatchObject({ outcome: "no-owner" });
		expect(result.message).toMatch(/propose_contract_change|amendment/i);
		expect((await saved()).laneChangeRequests).toEqual([]);
	});

	it("marks an owner's request integrated and tells the requester to merge the task base", async () => {
		await setup({ slices: [slice("a"), slice("b", { reviewHead: "owner-head", reviews: approved("owner-head") })] });
		fake.agentStatus.set("t1--b", "working");
		fake.agentStatus.set("t1--a", "done");
		const created = await coordinator.requestLaneChange("a", request);
		if (created.outcome !== "requested") throw new Error("expected request to be delivered");
		await coordinator.integrate("b");
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ id: created.request.id, status: "integrated" });
		expect(fake.env.BUILDER.getByName("t1--a").revise).toHaveBeenCalledWith(expect.stringMatching(/integrated.*fetch_base|fetch_base.*integrated/is), expect.anything());
	});
});
