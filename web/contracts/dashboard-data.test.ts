import { describe, expect, it } from "vitest";
import type { Live, Task } from "../src/api";
import { buildMergeMatrix, getSliceStage, mergeActivity, newestTasks } from "../src/lib/dashboardData";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task", repo: "repo", goal: "goal", phase: "building", verify: [],
    review: { reviewers: ["tests"], required: 1, vetoes: [] }, slices: [], checks: [],
    limits: { builders: 1, reviewers: 1 }, queue: [], active: { builders: [], reviewers: [] },
    createdAt: "2025-01-01T00:00:00.000Z", ...overrides,
  };
}
function makeSlice(overrides: Partial<Task["slices"][number]> = {}): Task["slices"][number] {
  return {
    id: "one", title: "One", owns: ["src/"], instructions: "build", status: "building",
    touched: [], outOfLane: [], reviews: [], ...overrides,
  };
}

describe("dashboard data helpers", () => {
  it("derives stage precedence and retains the revision count", () => {
    expect(getSliceStage(makeSlice({ attention: "needs a person", revisions: 3 }))).toEqual({ stage: "needs-human", revisions: 3 });
    expect(getSliceStage(makeSlice({ status: "integrated", gate: { status: "running", head: "h", baseHead: "b", at: "now", excluded: [] } })).stage).toBe("integrated");
    expect(getSliceStage(makeSlice({ gate: { status: "running", head: "h", baseHead: "b", at: "now", excluded: [] } })).stage).toBe("gate");
    expect(getSliceStage(makeSlice({ reviewHead: "head" })).stage).toBe("in-review");
    expect(getSliceStage(makeSlice()).stage).toBe("building");
  });

  it("builds a base-and-slice matrix and picks the newest check regardless of pair orientation", () => {
    const task = makeTask({
      slices: [makeSlice(), makeSlice({ id: "two", title: "Two" })],
      checks: [
        { pair: ["one", "two"], heads: ["a", "b"], status: "conflict", files: ["old.ts"], checkedAt: "2025-01-01" },
        { pair: ["two", "one"], heads: ["b", "a"], status: "clean", files: [], checkedAt: "2025-02-01" },
        { pair: ["base", "one"], heads: ["base", "a"], status: "disjoint", files: [], checkedAt: "2025-02-02" },
      ],
    });
    const matrix = buildMergeMatrix(task);
    expect(matrix.ids).toEqual(["base", "one", "two"]);
    expect(matrix.cells[0][0].status).toBe("same");
    expect(matrix.cells[0][1].status).toBe("disjoint");
    expect(matrix.cells[1][2]).toMatchObject({ status: "clean", checkedAt: "2025-02-01" });
    expect(matrix.cells[0][2].status).toBe("unchecked");
  });

  it("merges builder/reviewer logs newest-first and hides run commands by default", () => {
    const agents: Live["agents"] = [
      { id: "one", builder: { status: "done", startedAt: "", turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, log: [{ at: "2025-01-01", event: "pushed" }, { at: "2025-01-03", event: "run: npm test" }] }, reviewers: [{ role: "tests", state: { status: "done", startedAt: "", turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, log: [{ at: "2025-01-02", event: "approved" }] } }] },
    ];
    expect(mergeActivity(agents).map((event) => [event.agent, event.event])).toEqual([["tests", "approved"], ["builder", "pushed"]]);
    expect(mergeActivity(agents, true)[0].event).toBe("run: npm test");
  });

  it("sorts tasks newest first without mutating the input", () => {
    const old = makeTask({ id: "old", createdAt: "2025-01-01" });
    const newer = makeTask({ id: "new", createdAt: "2025-02-01" });
    const tasks = [old, newer];
    expect(newestTasks(tasks).map((task) => task.id)).toEqual(["new", "old"]);
    expect(tasks[0]).toBe(old);
  });
});
