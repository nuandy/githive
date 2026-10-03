import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../src/agent";
import type { BuildJob, BuilderState } from "../../src/builder";
import { FakeStorage } from "../fakes/env";

const { Builder } = await import("../../src/builder");

describe("builder cross-lane tools", () => {
	it("asks the Coordinator to route a lane request without adding a person identity", async () => {
		const requestLaneChange = vi.fn(async () => ({ outcome: "requested" as const, delivery: "inbox" as const, message: "delivered" }));
		const coordinator = { requestLaneChange, answerLaneChange: vi.fn() };
		const env = { COORDINATOR: { idFromName: (id: string) => id, get: () => coordinator } };
		const builder = new Builder({ storage: new FakeStorage() } as never, env as never);
		const job: BuildJob = {
			taskId: "t1", goal: "goal", slice: { id: "a", title: "A", owns: ["src/a/"], instructions: "build", tests: [] },
			siblings: [{ id: "b", title: "B", owns: ["src/b/"] }], contracts: [], verify: [], repo: "t1--a",
			remote: "https://git.test/t1--a.git", token: "token", base: { remote: "https://git.test/t1--base.git", token: "base-token" },
		};
		const state = { pushes: 0, revisions: 0, log: [] } as unknown as BuilderState;
		const tools = (builder as unknown as { tools(job: BuildJob, state: BuilderState): AgentTool[] }).tools(job, state);
		const tool = tools.find((item) => item.name === "request_lane_change");
		expect(tool).toBeDefined();
		await tool!.run({ path: "src/b/routes.ts", need: "Register a route", reason: "The API slice needs it" } as never);
		expect(requestLaneChange).toHaveBeenCalledWith("a", { path: "src/b/routes.ts", need: "Register a route", reason: "The API slice needs it" });
		expect(JSON.stringify(requestLaneChange.mock.calls)).not.toContain("human@example.com");
	});
});
