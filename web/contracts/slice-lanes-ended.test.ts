import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Live, Task } from "../src/api";
import { SliceLanes } from "../src/components/SliceLanes";

// An open task lives as long as its repo: most of its changes have ended. The
// list leads with the changes in progress and folds the ended ones away.

const slice = (id: string, status: Task["slices"][number]["status"]): Task["slices"][number] => ({ id, title: `Title ${id}`, owns: [`src/${id}/`], instructions: "", status, touched: [], outOfLane: [], reviews: [] });
const live = (slices: Task["slices"]): Live => ({
  task: { id: "t", repo: "r", goal: "g", phase: "building", mode: "open", verify: [], review: { reviewers: ["tests"], required: 1, vetoes: [] }, slices, checks: [], limits: { builders: 1, reviewers: 1 }, queue: [], active: { builders: [], reviewers: [] }, createdAt: "" } as Task,
  agents: [],
});

describe("the change list", () => {
  it("shows changes in progress, and folds ended ones (integrated or abandoned) under a count", () => {
    const html = renderToStaticMarkup(createElement(SliceLanes, { live: live([slice("live", "building"), slice("gone", "abandoned"), slice("done", "integrated")]) }));
    const [open, folded] = html.split("<details");
    expect(open).toContain("Title live");
    expect(open).not.toContain("Title gone");
    expect(folded).toMatch(/2 ended changes/);
    expect(folded).toContain("Title gone");
    expect(folded).toContain("Abandoned");
    expect(folded).toContain("Integrated");
  });

  it("has no folded list when nothing has ended", () => {
    expect(renderToStaticMarkup(createElement(SliceLanes, { live: live([slice("live", "building")]) }))).not.toContain("<details");
  });
});
