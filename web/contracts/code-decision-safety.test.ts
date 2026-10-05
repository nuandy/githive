import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import source from "../src/components/CodeDecisions.tsx?raw";
import { describe, expect, it } from "vitest";
import type { Task } from "../src/api";
import { CodeDecisions } from "../src/components/CodeDecisions";

const task = {
  id: "task",
  repo: "example",
  goal: "A task under review",
  phase: "building",
  mode: "open",
  verify: [],
  review: { reviewers: [], required: 0, vetoes: [] },
  slices: [],
} as unknown as Task;

describe("dashboard code decision safety and keyboard access", () => {
  it("keeps a waiver unavailable until its pinned slice diff has loaded", () => {
    const blocked = {
      ...task,
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
    }));
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Waive review quorum<\/button>/);
    expect(markup).toContain("Loading slice diff");
    expect(markup).not.toMatch(/contract|confirm land|landing/i);
  });

  it("makes scrollable code blocks keyboard reachable", () => {
    expect(source).toMatch(/<pre[^>]*tabIndex=\{0\}/);
  });
});
