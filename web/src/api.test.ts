import { describe, expect, it } from "vitest";
import { normalizeLive, normalizeTask } from "./api";

const persistedTask = {
  id: "legacy",
  repo: "example",
  goal: "Keep old task data visible",
  phase: "building",
  createdAt: "2025-01-01T00:00:00.000Z",
  slices: [{ id: "one", title: "First slice", status: "building" }],
};

describe("dashboard API compatibility", () => {
  it("fills legacy task collections without discarding persisted fields", () => {
    const task = normalizeTask(persistedTask);
    expect(task).toMatchObject({
      id: "legacy",
      repo: "example",
      goal: "Keep old task data visible",
      createdAt: "2025-01-01T00:00:00.000Z",
      verify: [],
      review: { reviewers: [], required: 0, vetoes: [] },
      slices: [{ id: "one", title: "First slice", owns: [], touched: [], outOfLane: [], reviews: [] }],
      checks: [],
      laneChangeRequests: [],
    });
  });

  it("safely normalizes cross-lane request records and drops malformed entries", () => {
    const task = normalizeTask({
      ...persistedTask,
      laneChangeRequests: [
        { id: "req", requester: "ui", owner: "api", path: "src/api.ts", need: "Add field", reason: "UI relies on it", status: "answered", createdAt: "then", answer: "Done", answerCommit: "abc123" },
        { id: "bad", requester: "ui", status: "unknown" },
        null,
      ],
    });
    expect(task.laneChangeRequests).toEqual([{
      id: "req",
      requester: "ui",
      owner: "api",
      path: "src/api.ts",
      need: "Add field",
      reason: "UI relies on it",
      status: "answered",
      createdAt: "then",
      answer: "Done",
      answerCommit: "abc123",
    }]);
  });

  it("normalizes missing live log, reviewer, and usage data", () => {
    const live = normalizeLive({ task: persistedTask, agents: [{ id: "one", builder: { status: "done" } }] });
    expect(live.task.id).toBe("legacy");
    expect(live.agents[0].builder).toMatchObject({
      log: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    });
    expect(live.agents[0].reviewers).toEqual([]);
  });

  it("rejects an unusable task payload so the request failure remains visible", () => {
    expect(() => normalizeTask({ goal: "No task id" })).toThrow("Invalid task response");
  });
});
