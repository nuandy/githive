import { describe, expect, it } from "vitest";
import type { Task } from "../src/api";
import { buildMergeMatrix } from "../src/lib/dashboardData";

const slice = (id: string, status: Task["slices"][number]["status"]): Task["slices"][number] => ({
  id,
  title: id,
  owns: [],
  instructions: "",
  status,
  touched: [],
  outOfLane: [],
  reviews: [],
});

const task = (): Task => ({
  id: "task",
  repo: "repo",
  goal: "goal",
  phase: "building",
  contracts: [],
  verify: [],
  review: { reviewers: ["tests"], required: 1, vetoes: [] },
  slices: [slice("integrated-one", "integrated"), slice("building-two", "building")],
  checks: [
    { pair: ["base", "integrated-one"], heads: ["base", "one"], status: "clean", files: [], checkedAt: "2025-01-01T00:00:00.000Z" },
    { pair: ["integrated-one", "building-two"], heads: ["one", "two"], status: "conflict", files: ["shared.ts"], checkedAt: "2025-01-02T00:00:00.000Z" },
    { pair: ["base", "building-two"], heads: ["base", "two"], status: "disjoint", files: [], checkedAt: "2025-01-03T00:00:00.000Z" },
  ],
  createdAt: "2025-01-01T00:00:00.000Z",
});

describe("integrated merge-ahead matrix pairs", () => {
  it("labels pairs involving integrated slices as integrated, regardless of retained check status", () => {
    const matrix = buildMergeMatrix(task());
    const at = (row: string, column: string) => matrix.cells[matrix.ids.indexOf(row)][matrix.ids.indexOf(column)].status;

    expect(at("base", "base")).toBe("same");
    expect(at("base", "integrated-one")).toBe("integrated");
    expect(at("integrated-one", "base")).toBe("integrated");
    expect(at("integrated-one", "building-two")).toBe("integrated");
    expect(at("base", "building-two")).toBe("disjoint");
  });
});
