import { describe, expect, it } from "vitest";
import { builderGitCommandBlockReason } from "../../src/git-command-safety";

describe("builder Git command safety contract", () => {
  it.each([
    "git push --force origin HEAD:main",
    "git push -f origin HEAD:main",
    "git push --force-with-lease origin HEAD:main",
    "git push origin +HEAD:main",
  ])("refuses force-push command %s even before a builder push", (command) => {
    expect(builderGitCommandBlockReason(command, false)).toMatch(/force/i);
  });

  it.each([
    "git commit --amend --no-edit",
    "git rebase base/main",
    "git rebase -i HEAD~2",
  ])("refuses rewriting pushed history with %s", (command) => {
    const reason = builderGitCommandBlockReason(command, true);
    expect(reason).toMatch(/pushed/i);
    expect(reason).toMatch(/new commit/i);
    expect(reason).toContain("git merge base/main");
  });

  it("allows amend and rebase before the builder has pushed", () => {
    expect(builderGitCommandBlockReason("git commit --amend", false)).toBeUndefined();
    expect(builderGitCommandBlockReason("git rebase base/main", false)).toBeUndefined();
  });

  it("allows ordinary pushes and read-only Git commands after a push", () => {
    expect(builderGitCommandBlockReason("git push origin HEAD:main", true)).toBeUndefined();
    expect(builderGitCommandBlockReason("git status && git log --oneline && git diff", true)).toBeUndefined();
    expect(builderGitCommandBlockReason("git -C /work status", true)).toBeUndefined();
  });
});
