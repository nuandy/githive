import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";
import type { LaneChangeCoordinator, LaneChangeRequestInput } from "../../src/lane-change-contract";
const io = vi.hoisted(() => ({ heads: new Map<string, string>(), answerCommitIncluded: true }));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/git", () => ({
	Workspace: { clone: vi.fn(async () => ({
		fetch: vi.fn(async () => "fetched"), merge: vi.fn(async () => undefined),
		mergeBase: vi.fn(async (commit: string) => io.answerCommitIncluded ? commit : "common"),
		push: vi.fn(async () => { io.heads.set("t1--base", "integrated-head"); }),
	})) },
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));
const { Coordinator } = await import("../../src/coordinator");
let fake: ReturnType<typeof fakeEnv>;
let storage: FakeStorage;
let coordinator: InstanceType<typeof Coordinator>;
const laneCoordinator = () => coordinator as unknown as LaneChangeCoordinator;
const requestInput: LaneChangeRequestInput = { path: "src/b/routes.ts", need: "Add the route registration.", reason: "Slice a needs this endpoint." };
const approved = (head: string) => [
	{ reviewer: "tests", head, verdict: "approve" as const, summary: "ok", at: "" },
	{ reviewer: "api", head, verdict: "approve" as const, summary: "ok", at: "" },
];
async function setup(overrides: Parameters<typeof task>[0] = {}) {
	storage = new FakeStorage(); fake = fakeEnv();
	io.heads.clear(); io.heads.set("t1--base", "base0"); io.heads.set("t1--a", "a-head"); io.heads.set("t1--b", "owner-head"); io.answerCommitIncluded = true;
	await storage.put("task", task({ slices: [slice("a"), slice("b")], laneChangeRequests: [], active: { builders: ["a", "b"], reviewers: [] }, verify: [], ...overrides }));
	coordinator = new Coordinator({ storage } as never, fake.env as never);
}
const saved = async () => (await storage.get<ReturnType<typeof task>>("task"))!;
async function makeRequest() {
	const result = await laneCoordinator().requestLaneChange("a", requestInput);
	if (result.outcome !== "requested") throw new Error("expected request to be delivered");
	return result.request;
}
describe("cross-lane request commit provenance", () => {
	beforeEach(() => vi.clearAllMocks());
	it("records Artifact HEAD for done, not a commit reported by the builder", async () => {
		await setup();
		const request = await makeRequest();
		const answered = await laneCoordinator().answerLaneChange("b", request.id, { outcome: "done", answer: "Implemented and pushed.", commit: "untrusted-model-commit" });
		expect(answered).toMatchObject({ status: "answered", answerCommit: "owner-head" });
		expect(answered.answerCommit).not.toBe("untrusted-model-commit");
	});
	it("fulfills a request only when the recorded commit is included by integration", async () => {
		await setup({ slices: [slice("a"), slice("b", { reviewHead: "owner-head", reviews: approved("owner-head") })] });
		const request = await makeRequest();
		await laneCoordinator().answerLaneChange("b", request.id, { outcome: "done", answer: "Implemented and pushed." });
		// Its approvals in, the owner integrates (no checks configured here).
		await coordinator.submitReview("b", { reviewer: "tests", head: "owner-head", verdict: "approve", summary: "ok", evidence: "ok" });
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ status: "integrated", answerCommit: "owner-head" });
		expect(fake.env.BUILDER.getByName("t1--a").revise).toHaveBeenCalled();
	});
	it("hands an answered request to a human if its recorded commit is absent from integration", async () => {
		await setup({ slices: [slice("a"), slice("b", { reviewHead: "owner-head", reviews: approved("owner-head") })] });
		const request = await makeRequest();
		await laneCoordinator().answerLaneChange("b", request.id, { outcome: "done", answer: "Implemented and pushed." });
		io.answerCommitIncluded = false;
		// Its approvals in, the owner integrates (no checks configured here).
		await coordinator.submitReview("b", { reviewer: "tests", head: "owner-head", verdict: "approve", summary: "ok", evidence: "ok" });
		expect((await saved()).laneChangeRequests![0].status).toBe("human");
		expect((await saved()).slices[0].attention).toMatch(/human|integrated/i);
	});
	it("delivers an owner's decline and reason to the requester", async () => {
		await setup();
		const request = await makeRequest();
		await laneCoordinator().answerLaneChange("b", request.id, { outcome: "declined", answer: "The route cannot be added in this lane." });
		expect((await saved()).laneChangeRequests![0]).toMatchObject({ status: "declined", answer: expect.stringContaining("cannot be added") });
		expect(fake.env.BUILDER.getByName("t1--a").notify).toHaveBeenCalledWith(expect.stringContaining("cannot be added"));
	});
});
