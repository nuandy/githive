import { describe, expect, it } from "vitest";
import { GIT_IN_BLUEPRINT } from "../../src/git-blueprint-guidance";

describe("Git in Blueprint guidance contract", () => {
  it("covers pinned-history-safe Git habits", () => {
    expect(GIT_IN_BLUEPRINT).toContain("Git in Blueprint");
    expect(GIT_IN_BLUEPRINT).toMatch(/Never rewrite history that has been pushed/);
    expect(GIT_IN_BLUEPRINT).toContain("git merge base/main");
    expect(GIT_IN_BLUEPRINT).toContain("not against the moving `base/main` tip");
    expect(GIT_IN_BLUEPRINT).toContain("git reset --hard");
    expect(GIT_IN_BLUEPRINT).toContain("git checkout -- .");
    expect(GIT_IN_BLUEPRINT).toContain("git clean -fdx");
  });
});
