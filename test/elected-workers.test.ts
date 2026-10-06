import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../src/agent";
import { taskCoordinator } from "../src/elected";
import type { ReviewJob, ReviewerState } from "../src/reviewer";
import { FakeStorage } from "./fakes/env";

// Blueprint's own workers (builders, reviewers, the gate) report back to the
// task's coordinator. For an open task run by the elected coordinator, that is
// whichever peer leads; for any other task, its Coordinator object.

const { Reviewer } = await import("../src/reviewer");

/** Bindings where task t1 is elected (led by t1--lead) and task p1 is planned. */
function bindings() {
	const calls: { to: string; method: string; args: unknown[] }[] = [];
	const recorder = (to: string) =>
		new Proxy({}, { get: (_t, method: string) => (method === "then" ? undefined : async (...args: unknown[]) => (calls.push({ to, method, args }), method === "submitReview" ? { quorum: { status: "pending" } } : undefined)) });
	const env = {
		TASK_INDEX: { getByName: () => ({ get: async (id: string) => (id === "t1" ? { id, repo: "project", elected: true, leader: { name: "t1--lead", term: 3 } } : { id, repo: "project" }) }) },
		PEER: { getByName: (name: string) => recorder(`peer ${name}`) },
		COORDINATOR: { idFromName: (name: string) => name, get: (id: string) => recorder(`coordinator ${id}`) },
	};
	return { env, calls };
}

describe("workers' callbacks", () => {
	it("go to the leader for an elected task, and to the Coordinator object otherwise", async () => {
		const { env, calls } = bindings();
		await taskCoordinator(env as never, "t1").gatePlan("stats", "h1", undefined);
		await taskCoordinator(env as never, "p1").gatePlan("slice-a", "h2", undefined);
		expect(calls).toEqual([
			{ to: "peer t1--lead", method: "gatePlan", args: ["stats", "h1", undefined] },
			{ to: "coordinator p1", method: "gatePlan", args: ["slice-a", "h2", undefined] },
		]);
	});

	it("carry a hosted reviewer's verdict on an elected task to its leader", async () => {
		const { env, calls } = bindings();
		const reviewer = new Reviewer({ storage: new FakeStorage() } as never, env as never);
		const job = { taskId: "t1", role: "tests", head: "h1", baseCommit: "b0", slice: { id: "stats", owns: ["src/stats/"] } } as unknown as ReviewJob;
		const tools = (reviewer as unknown as { tools(job: ReviewJob, state: ReviewerState): AgentTool[] }).tools(job, { log: [] } as unknown as ReviewerState);
		await tools.find((t) => t.name === "submit_verdict")!.run({ verdict: "approve", summary: "fine", evidence: "tests pass" } as never);
		expect(calls).toEqual([{ to: "peer t1--lead", method: "submitReview", args: ["stats", expect.objectContaining({ reviewer: "tests", head: "h1", verdict: "approve" })] }]);
	});
});
