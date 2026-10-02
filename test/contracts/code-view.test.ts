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

  it("quotes control characters in paths so they cannot inject diff headers", () => {
    const diff = unifiedDiff([{
      path: "src/innocent.ts\nnew file mode 100644\n--- a/.github/workflows/release.yml\n+++ b/.github/workflows/release.yml",
      before: null,
      after: "export const harmless = true\n",
    }]);
    const lines: string[] = diff.split("\n");
    expect(diff).toContain(String.raw`a/src/innocent.ts\nnew file mode`);
    expect(lines).not.toContain("--- a/.github/workflows/release.yml");
    expect(lines).not.toContain("+++ b/.github/workflows/release.yml");
    // The single real added-file marker remains, but no marker is injected from the path.
    expect(lines.filter((line: string) => line === "new file mode 100644")).toHaveLength(1);
  });

  it("returns an empty string for no changed files and omits unchanged entries", () => {
    expect(unifiedDiff([])).toBe("");
    expect(unifiedDiff([{ path: "same.ts", before: "same\n", after: "same\n" }])).toBe("");
  });
});
