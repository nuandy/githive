import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import source from "../src/components/CodeDecisions.tsx?raw";
import { describe, expect, it } from "vitest";
import type { Task } from "../src/api";
import { CodeDecisions } from "../src/components/CodeDecisions";
import { TaskHeader } from "../src/components/TaskHeader";

const task = {
  id: "task",
  repo: "example",
  goal: "A task under review",
  phase: "awaiting-approval",
  contracts: ["test/contract.ts"],
  verify: [],
  review: { reviewers: [], required: 0, vetoes: [] },
  slices: [],
} as unknown as Task;

function header(contractsReady: boolean) {
  return renderToStaticMarkup(createElement(TaskHeader, {
    task,
    plannerRunning: false,
    busy: false,
    contractsReady,
    onPlan: () => undefined,
    onApproveAndBuild: () => undefined,
  }));
}

describe("dashboard code decision safety and keyboard access", () => {
  it("does not allow blueprint approval until contracts loaded successfully", () => {
    expect(header(false)).toMatch(/<button[^>]*disabled=""[^>]*>Approve and build<\/button>/);
    expect(header(true)).toMatch(/<button[^>]*>Approve and build<\/button>/);
  });

  it("keeps a waiver unavailable until its pinned slice diff has loaded", () => {
    const blocked = {
      ...task,
      phase: "building",
      slices: [{
        id: "slice",
        title: "Slice",
        owns: [],
        instructions: "",
        status: "needs-human",
        attention: "Review needed",
        touched: [],
        outOfLane: [],
        reviews: [],
        reviewHead: "pinned-head",
        mergeBase: "base",
      }],
    } as unknown as Task;
    const markup = renderToStaticMarkup(createElement(CodeDecisions, {
      task: blocked,
      busy: false,
      onWaive: () => undefined,
      onLand: () => undefined,
      onContractFilesReady: () => undefined,
    }));
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Waive review quorum<\/button>/);
    expect(markup).toContain("Loading slice diff");
  });

  it("makes scrollable code blocks keyboard reachable", () => {
    expect(source).toMatch(/<pre[^>]*tabIndex=\{0\}/);
  });
});
