import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";
import type { LaneChangeCoordinator, LaneChangeRequest } from "../../src/lane-change-contract";
import type { AccessIdentity } from "../../src/access-contract";
const io = vi.hoisted(() => ({ heads: new Map<string, string>() }));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async (_artifacts: unknown, repo: string) => io.heads.get(repo)),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));
const { Coordinator } = await import("../../src/coordinator");
let storage: FakeStorage;
let fake: ReturnType<typeof fakeEnv>;
let coordinator: InstanceType<typeof Coordinator>;
const lane = () => coordinator as unknown as LaneChangeCoordinator;
const saved = async () => (await storage.get<ReturnType<typeof task>>("task"))!;
const delivered: Record<string, string[]> = {};
const wake = (id: string) => (fake.env.BUILDER.getByName(`t1--${id}`) as unknown as { wake: ReturnType<typeof vi.fn> }).wake;
async function setup() {
	storage = new FakeStorage(); fake = fakeEnv(); delivered.a = []; delivered.b = [];
	io.heads.clear(); io.heads.set("t1--base", "base0"); io.heads.set("t1--a", "a-head"); io.heads.set("t1--b", "b-head");
	await storage.put("task", task({ slices: [slice("a"), slice("b")], laneChangeRequests: [], active: { builders: ["a", "b"], reviewers: [] }, verify: [] }));
	for (const id of ["a", "b"]) {
		const agent = fake.env.BUILDER.getByName(`t1--${id}`) as unknown as { wake: ReturnType<typeof vi.fn>; park: ReturnType<typeof vi.fn>; markParkTimedOut: ReturnType<typeof vi.fn> };
		agent.wake = vi.fn(async (_eventId: string, message: string) => {
			delivered[id].push(message);
			if (fake.agentStatus.get(`t1--${id}`) === "working") return "deferred" as const;
			fake.agentStatus.set(`t1--${id}`, "queued");
			return "resumed" as const;
		});
		agent.park = vi.fn(async () => { fake.agentStatus.set(`t1--${id}`, "parked" as never); });
		agent.markParkTimedOut = vi.fn(async () => true);
	}
	fake.agentStatus.set("t1--a", "working");
	fake.agentStatus.set("t1--b", "working");
	coordinator = new Coordinator({ storage } as never, fake.env as never);
}
const actor: AccessIdentity = { kind: "person", value: "team-member@example.invalid" };
const input = { path: "src/b/api.ts", need: "Expose the endpoint.", reason: "The requester needs this route." };
async function createRequest() {
	const result = await lane().requestLaneChange("a", input);
	if (result.outcome !== "requested") throw new Error("expected a delivered request");
	return result.request;
}
beforeEach(() => vi.clearAllMocks());
describe("Coordinator wake event delivery", () => {
	it("delivers a resolution to the inbox when a human message already woke the working builder", async () => {
		await setup();
		const request = await createRequest();
		await coordinator.messageBuilder("a", "Continue with the current implementation.", actor);
		await lane().answerLaneChange("b", request.id, { outcome: "declined", answer: "The endpoint cannot be exposed from this lane." });
		expect(delivered.a).toEqual(expect.arrayContaining([
			expect.stringContaining("Message from a human"),
			expect.stringContaining("cannot be exposed"),
		]));
		expect(String(wake("a").mock.calls[1][0])).toMatch(/^lane-change:/);
		expect(delivered.a.join("\n")).not.toContain(actor.value);
	});
	it("ignores a duplicate of the same request outcome without delivering it twice", async () => {
		await setup();
		const request = await createRequest();
		await lane().answerLaneChange("b", request.id, { outcome: "declined", answer: "Not possible in this lane." });
		const count = wake("a").mock.calls.length;
		const latestTask = await saved();
		const resolved = latestTask.laneChangeRequests!.find((item) => item.id === request.id)!;
		await (coordinator as unknown as { wakeLaneRequester(latestTask: ReturnType<typeof task>, request: LaneChangeRequest, message: string): Promise<void> })
			.wakeLaneRequester(latestTask, resolved, "Not possible in this lane.");
		expect(wake("a")).toHaveBeenCalledTimes(count);
	});
});
