import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../../src/code-view";

describe("read-only unified code diffs", () => {
  it("shows Git-style headers, hunk markers, and changed lines for an edit", () => {
    const diff = unifiedDiff([{ path: "src/value.ts", before: "const value = 1;\n", after: "const value = 2;\n" }]);
    expect(diff).toContain("--- a/src/value.ts");
    expect(diff).toContain("+++ b/src/value.ts");
    expect(diff).toContain("@@");
    expect(diff).toContain("-const value = 1;");
    expect(diff).toContain("+const value = 2;");
  });

  it("marks added and deleted files with /dev/null", () => {
    const diff = unifiedDiff([
      { path: "new.ts", before: null, after: "new file\n" },
      { path: "gone.ts", before: "old file\n", after: null },
    ]);
    expect(diff).toContain("--- /dev/null\n+++ b/new.ts");
    expect(diff).toContain("--- a/gone.ts\n+++ /dev/null");
  });

  it("returns an empty string for no changed files and omits unchanged entries", () => {
    expect(unifiedDiff([])).toBe("");
    expect(unifiedDiff([{ path: "same.ts", before: "same\n", after: "same\n" }])).toBe("");
  });
});
