import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "../fakes/env";
import { runCall } from "../../src/agent";
import type { BuildJob, BuilderState } from "../../src/builder";
import type { AgentTool } from "../../src/agent";
import type { LaneChangeCoordinator } from "../../src/lane-change-contract";
const { Builder } = await import("../../src/builder");
const now = "2026-10-02T00:00:00.000Z";
const job = {
	taskId: "t1", goal: "cross-lane change", repo: "t1--a", remote: "https://git.test/a.git", token: "write-a",
	base: { remote: "https://git.test/base.git", token: "read-base" },
	slice: { id: "a", title: "A", owns: ["src/a/"], instructions: "Build A" }, siblings: [{ id: "b", title: "B", owns: ["src/b/"] }], contracts: [], verify: [],
} as BuildJob;
const freshState = (): BuilderState => ({ status: "working", startedAt: now, turns: 5, turnsAtRunStart: 0, toolCalls: 0, nudges: 0, pushes: 1, revisions: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, log: [], pending: [] });
class ToolHarness extends Builder {
	rpc: LaneChangeCoordinator = {} as LaneChangeCoordinator;
	ahead = 0;
	getTools(j: BuildJob, s: BuilderState): AgentTool[] { return this.tools(j, s); }
	protected override coordinator(_job: BuildJob) { return this.rpc as never; }
	protected override async exec(args: string[]) {
		if (args[0] === "git" && args[1] === "rev-list") return { exitCode: 0, output: `${this.ahead}\n` };
		if (args[0] === "git" && args[1] === "status") return { exitCode: 0, output: "" };
		return { exitCode: 0, output: "" };
	}
	protected override async afterClone() {}
}
let builder: ToolHarness;
let rpc: LaneChangeCoordinator;
let current: BuilderState;
beforeEach(() => {
	const storage = new FakeStorage();
	const context = { storage, container: { running: true, destroy: vi.fn(async () => undefined), setInactivityTimeout: vi.fn(async () => undefined) } };
	builder = new ToolHarness(context as never, { OPENAI_API_KEY: "test" } as never);
	current = freshState();
	rpc = {
		requestLaneChange: vi.fn(async () => ({ outcome: "no-owner", message: "no owner" })),
		answerLaneChange: vi.fn(async () => ({ id: "r1", requester: "a", owner: "b", path: "src/b/api.ts", need: "Add export", reason: "Needed", status: "answered", createdAt: now, answer: "done", answerCommit: "artifact-head" })),
		parkBuilder: vi.fn(async () => ({ outcome: "parked", parkedAt: now, waitingFor: ["r1"] })),
		parkedBuilderTimedOut: vi.fn(async () => undefined),
	} as unknown as LaneChangeCoordinator;
	builder.rpc = rpc;
});
describe("builder parking tools", () => {
	it("exposes wait_for_requests and records a distinct parked state without a revision", async () => {
		const result = await runCall(builder.getTools(job, current), "wait_for_requests", "{}");
		expect(result).toMatch(/park|wait/i);
		expect(rpc.parkBuilder).toHaveBeenCalledWith("a");
		expect(current.status).toBe("parked");
		expect(current.revisions).toBe(0);
	});
	it("returns the Coordinator's resolution immediately when a request resolved before parking", async () => {
		vi.mocked(rpc.parkBuilder).mockResolvedValue({ outcome: "refused", reason: "Request r1 was already integrated; fetch base/main and merge it." });
		const result = await runCall(builder.getTools(job, current), "wait_for_requests", "{}");
		expect(result).toMatch(/already integrated|merge/i);
		expect(current.status).toBe("working");
	});
	it("refuses a done answer with unpushed commits and never sends a model commit", async () => {
		builder.ahead = 2;
		const result = await runCall(builder.getTools(job, current), "answer_lane_change", JSON.stringify({ request_id: "r1", outcome: "done", answer: "Implemented" }));
		expect(result).toMatch(/unpushed|commit_and_push/i);
		expect(rpc.answerLaneChange).not.toHaveBeenCalled();
		builder.ahead = 0;
		await runCall(builder.getTools(job, current), "answer_lane_change", JSON.stringify({ request_id: "r1", outcome: "done", answer: "Implemented" }));
		expect(rpc.answerLaneChange).toHaveBeenCalledWith("a", "r1", { outcome: "done", answer: "Implemented" });
	});
	it("resumes a parked conversation with fresh credentials and a new turn budget, without a revision", async () => {
		await builder.start(job);
		const parked = (await builder.state()) as BuilderState;
		Object.assign(parked, { status: "parked", turns: 5, turnsAtRunStart: 0, revisions: 0 });
		await (builder as unknown as { save(state: BuilderState): Promise<void> }).save(parked);
		await builder.wake("Request r1 integrated; merge base/main.", { token: "fresh-write", base: { remote: "https://git.test/base.git", token: "fresh-read" } });
		expect((await builder.state())?.status).toBe("queued");
		expect((await builder.state() as BuilderState).revisions).toBe(0);
		expect((await builder.state() as BuilderState).turnsAtRunStart).toBe(5);
	});
});
