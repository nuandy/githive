import { describe, expect, it } from "vitest";
import type { Live, Task } from "../src/api";
import { buildMergeMatrix, mergeActivity } from "../src/lib/dashboardData";

const legacyTask = (overrides: Partial<Task> = {}): Task => ({
  id: "legacy-task",
  repo: "repo",
  goal: "A task created by an older Blueprint version",
  phase: "building",
  contracts: [],
  verify: [],
  review: { reviewers: [], required: 0, vetoes: [] },
  slices: [{
    id: "one", title: "One", owns: [], instructions: "", status: "building",
    touched: [], outOfLane: [], reviews: [],
  }],
  // Deliberately omit `checks`, which older persisted tasks may not contain.
  createdAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
} as Task);

describe("dashboard task detail safety", () => {
  it("renders legacy tasks without merge checks as unchecked pairs", () => {
    const matrix = buildMergeMatrix(legacyTask());
    expect(matrix.ids).toEqual(["base", "one"]);
    expect(matrix.cells[0][0].status).toBe("same");
    expect(matrix.cells[0][1].status).toBe("unchecked");
    expect(matrix.cells[1][0].status).toBe("unchecked");
  });

  it("does not throw when a legacy live agent has no log collection", () => {
    const agents = [{
      id: "one",
      builder: { status: "done", startedAt: "", turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
      reviewers: [],
    }] as unknown as Live["agents"];
    expect(mergeActivity(agents)).toEqual([]);
  });
});
