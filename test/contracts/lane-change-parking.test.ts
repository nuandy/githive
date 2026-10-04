import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";
import type { LaneChangeCoordinator } from "../../src/lane-change-contract";
const io = vi.hoisted(() => ({ heads: new Map<string, string>() }));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/git", () => ({
	Workspace: {
		clone: vi.fn(async () => ({
			fetch: vi.fn(async () => "fetched"),
			merge: vi.fn(async () => undefined),
			mergeBase: vi.fn(async (commit: string) => commit),
			push: vi.fn(async () => undefined),
		})),
	},
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));
const { Coordinator } = await import("../../src/coordinator");
let storage: FakeStorage;
let fake: ReturnType<typeof fakeEnv>;
let coordinator: InstanceType<typeof Coordinator>;
const lane = () => coordinator as unknown as LaneChangeCoordinator;
const saved = async () => (await storage.get<ReturnType<typeof task>>("task"))!;
async function setup(overrides: Parameters<typeof task>[0] = {}) {
	storage = new FakeStorage(); fake = fakeEnv();
	io.heads.clear(); io.heads.set("t1--base", "base0");
	for (const id of ["a", "b", "c"]) io.heads.set(`t1--${id}`, `${id}-head`);
	await storage.put("task", task({ slices: [slice("a"), slice("b"), slice("c")], laneChangeRequests: [], active: { builders: ["a", "b", "c"], reviewers: [] }, verify: [], ...overrides }));
	for (const id of ["a", "b", "c"]) {
		const agent = fake.env.BUILDER.getByName(`t1--${id}`) as unknown as { park: ReturnType<typeof vi.fn>; wake: ReturnType<typeof vi.fn>; markParkTimedOut: ReturnType<typeof vi.fn> };
		agent.park = vi.fn(async () => { fake.agentStatus.set(`t1--${id}`, "parked" as never); });
		agent.wake = vi.fn(async () => { fake.agentStatus.set(`t1--${id}`, "queued"); return "resumed"; });
		agent.markParkTimedOut = vi.fn(async () => true);
	}
	coordinator = new Coordinator({ storage } as never, fake.env as never);
}
const input = (path: string) => ({ path, need: "Add the required export.", reason: "A dependent slice needs it." });
beforeEach(() => vi.clearAllMocks());
describe("Coordinator parking decisions", () => {
	it("parks only with unresolved outgoing requests and frees the builder slot", async () => {
		await setup({ limits: { builders: 1, reviewers: 6 }, active: { builders: ["a"], reviewers: [] }, queue: [{ kind: "builder", slice: "b" }] });
		const request = await lane().requestLaneChange("a", input("src/b/api.ts"));
		expect(request.outcome).toBe("requested");
		const parked = await lane().parkBuilder("a");
		expect(parked.outcome).toBe("parked");
		expect((await saved()).active.builders).toContain("b");
		expect((await saved()).active.builders).not.toContain("a");
		expect(fake.env.BUILDER.getByName("t1--b").start).toHaveBeenCalledOnce();
	});
	it("refuses parking if resolution won the lock first and returns its outcome", async () => {
		await setup({ laneChangeRequests: [{ id: "r1", requester: "a", owner: "b", path: "src/b/api.ts", need: "Add export", reason: "Needed", status: "declined", answer: "Not possible in this lane.", createdAt: "now" }] });
		const result = await lane().parkBuilder("a");
		expect(result).toMatchObject({ outcome: "refused" });
		if (result.outcome === "refused") expect(result.reason).toMatch(/declined|Not possible/);
		expect((await saved()).active.builders).toContain("a");
	});
	it("rejects a request that would close a cross-lane wait cycle and flags it for a human", async () => {
		await setup({ laneChangeRequests: [{ id: "r1", requester: "b", owner: "a", path: "src/a/api.ts", need: "Change", reason: "Need", status: "pending", createdAt: "now" }] });
		const result = await lane().requestLaneChange("a", input("src/b/api.ts"));
		expect(result.outcome).toBe("human");
		expect((await saved()).slices[0].attention).toMatch(/cycle|deadlock|human/i);
		expect((await saved()).laneChangeRequests).toHaveLength(1);
	});
	it("treats repeated timeout reports as idempotent", async () => {
		await setup({ laneChangeRequests: [{ id: "r1", requester: "a", owner: "b", path: "src/b/api.ts", need: "Add export", reason: "Needed", status: "pending", createdAt: "now" }] });
		const park = await lane().parkBuilder("a");
		expect(park.outcome).toBe("parked");
		if (park.outcome !== "parked") return;
		await lane().parkedBuilderTimedOut("a", park.parkedAt);
		const before = (await saved()).slices[0].attention;
		await lane().parkedBuilderTimedOut("a", park.parkedAt);
		expect((await saved()).slices[0].attention).toBe(before);
	});
});
