import { describe, expect, it } from "vitest";
import { builderGitCommandBlockReason, builderGitPushBlockReason } from "../../src/git-command-safety";

describe("builder Git command safety contract", () => {
  it.each([
    "git push --force origin HEAD:main",
    "git push -f origin HEAD:main",
    "git push --force-with-lease origin HEAD:main",
    "git push origin +HEAD:main",
    "git -p push --force origin HEAD:main",
    "git -P push --force origin HEAD:main",
  ])("refuses force-push command %s even before a builder push", (command) => {
    expect(builderGitCommandBlockReason(command, false)).toMatch(/force/i);
  });

  it.each([
    "git commit --amend --no-edit",
    "git rebase base/main",
    "git rebase -i HEAD~2",
    'echo "$(git commit --amend --no-edit)"',
    "\\\ngit commit --amend -m changed",
  ])("refuses rewriting pushed history with %s", (command) => {
    const reason = builderGitCommandBlockReason(command, true);
    expect(reason).toMatch(/pushed/i);
    expect(reason).toMatch(/new commit/i);
    expect(reason).toContain("git merge base/main");
  });

  it.each([
    "bash -c 'git push --force origin HEAD:main'",
    'bash -lc "git push --force origin HEAD:main"',
  ])("refuses a nested shell force-push %s", (command) => {
    expect(builderGitCommandBlockReason(command, false)).toMatch(/force/i);
  });

  it("refuses force-pushes and pushes that discard pushed history", () => {
    const noRemoteAncestor = builderGitPushBlockReason({
      remoteHead: "fork-head",
      remoteHeadIsAncestor: false,
      forcePush: false,
      lastPushedHead: "fork-head",
      lastPushedHeadIsAncestor: false,
      hasPushedHistory: true,
    });
    expect(noRemoteAncestor).toMatch(/refusing to push/i);
    expect(noRemoteAncestor).toMatch(/make a new commit/i);
    expect(noRemoteAncestor).toContain("git merge base/main");

    expect(builderGitPushBlockReason({
      remoteHead: "fork-head",
      remoteHeadIsAncestor: true,
      forcePush: true,
      lastPushedHead: "fork-head",
      lastPushedHeadIsAncestor: true,
      hasPushedHistory: true,
    })).toMatch(/force-push/i);
  });

  it("allows initial pushes and pushes that preserve the fork and previously pushed heads", () => {
    expect(builderGitPushBlockReason({
      remoteHead: undefined,
      remoteHeadIsAncestor: false,
      forcePush: false,
      lastPushedHead: undefined,
      lastPushedHeadIsAncestor: false,
      hasPushedHistory: false,
    })).toBeUndefined();

    expect(builderGitPushBlockReason({
      remoteHead: "newer-fork-head",
      remoteHeadIsAncestor: true,
      forcePush: false,
      lastPushedHead: "previously-pushed-head",
      lastPushedHeadIsAncestor: true,
      hasPushedHistory: true,
    })).toBeUndefined();
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
