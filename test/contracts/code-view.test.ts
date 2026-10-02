import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { unifiedDiff } from "../../src/code-view";
import { Workspace } from "../../src/git";

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
    expect(lines.filter((line: string) => line === "new file mode 100644")).toHaveLength(1);
  });

  it("caps an oversized single-file diff and clearly reports the omission", () => {
    const large = "x".repeat(60_000);
    const diff = unifiedDiff([{ path: "package-lock.json", before: large, after: `${large}y` }]);
    expect(diff.length).toBeLessThan(10_000);
    expect(diff).toMatch(/omitted|limit/i);
  });

  it("caps aggregate diff output instead of expanding every large file", () => {
    const large = "x".repeat(40_000);
    const diff = unifiedDiff(Array.from({ length: 8 }, (_, index) => ({
      path: `lock-${index}.json`, before: large, after: `${large}${index}`,
    })));
    expect(diff.length).toBeLessThan(300_000);
    expect(diff).toMatch(/omitted|limit/i);
  });

  it("includes the replaced file and descendants when a Git path changes file/directory type", async () => {
    const workspace = await Workspace.init({ url: "https://git.test/repo.git", token: "unused" });
    await workspace.write({ "collision": "old file\n" });
    const fileCommit = await workspace.commit("file path");
    await git.remove({ fs: workspace.fs, dir: "/repo", filepath: "collision" });
    // isomorphic-git's remove only updates the index; remove the worktree file too.
    await workspace.fs.promises.unlink("/repo/collision");
    await workspace.write({ "collision/child.ts": "new child\n" });
    const directoryCommit = await workspace.commit("directory path");
    const fileToDirectory = await workspace.changedFiles(fileCommit, directoryCommit);
    expect(fileToDirectory).toEqual(expect.arrayContaining([
      { path: "collision", before: "old file\n", after: null },
      { path: "collision/child.ts", before: null, after: "new child\n" },
    ]));

    await workspace.write({ "reverse/child.ts": "old child\n" });
    const nestedCommit = await workspace.commit("nested path");
    await git.remove({ fs: workspace.fs, dir: "/repo", filepath: "reverse/child.ts" });
    await workspace.fs.promises.unlink("/repo/reverse/child.ts");
    await workspace.fs.promises.rmdir("/repo/reverse");
    await workspace.write({ reverse: "new file\n" });
    const reverseCommit = await workspace.commit("file replaces directory");
    const directoryToFile = await workspace.changedFiles(nestedCommit, reverseCommit);
    expect(directoryToFile).toEqual(expect.arrayContaining([
      { path: "reverse/child.ts", before: "old child\n", after: null },
      { path: "reverse", before: null, after: "new file\n" },
    ]));
  });

  it("returns an empty string for no changed files and omits unchanged entries", () => {
    expect(unifiedDiff([])).toBe("");
    expect(unifiedDiff([{ path: "same.ts", before: "same\n", after: "same\n" }])).toBe("");
  });
});
