import { describe, expect, it } from "vitest";
import { gitInBlueprint } from "../../src/git-blueprint-guidance";

describe("Git in Blueprint guidance contract", () => {
  it("covers pinned-history-safe Git habits, on the project's own branch", () => {
    const guidance = gitInBlueprint("master");
    expect(guidance).toContain("Git in Blueprint");
    expect(guidance).toMatch(/Never rewrite history that has been pushed/);
    expect(guidance).toContain("The project's branch is master");
    expect(guidance).toContain("git merge base/master");
    expect(guidance).toContain("not against the moving `base/master` tip");
    expect(guidance).not.toContain("main");
    expect(guidance).toContain("git reset --hard");
    expect(guidance).toContain("git checkout -- .");
    expect(guidance).toContain("git clean -fdx");
  });
});
