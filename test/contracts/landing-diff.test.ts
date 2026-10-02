import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  workspace: {
    head: vi.fn(async () => "project-main-head"),
    fetch: vi.fn(async () => "task-base-head"),
    mergeBase: vi.fn(async () => "common-ancestor"),
    changedFiles: vi.fn(async () => [{ path: "src/task.ts", before: "base\n", after: "task\n" }]),
  },
}));

vi.mock("../../src/git", () => ({ Workspace: { clone: vi.fn(async () => io.workspace) } }));
vi.mock("../../src/artifacts", () => ({
  baseRepoName: (id: string) => `${id}--base`,
  fileVersion: vi.fn(),
  forkAndWait: vi.fn(),
  headOf: vi.fn(),
  remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: "read" })),
  reviewerName: (repo: string, role: string, head: string) => `${repo}--${role}--${head}`,
  sliceRepoName: (id: string, slice: string) => `${id}--${slice}`,
}));

const { Coordinator } = await import("../../src/coordinator");

beforeEach(() => {
  io.workspace.head.mockClear();
  io.workspace.fetch.mockClear();
  io.workspace.mergeBase.mockClear();
  io.workspace.changedFiles.mockClear();
});

describe("landing diff ancestry", () => {
  it("shows task changes from the common ancestor, not changes reversed from moved project main", async () => {
    const task = {
      id: "task1234",
      repo: "project",
      phase: "building",
      baseRepo: "task1234--base",
      slices: [{ id: "slice", status: "integrated" }],
    };
    const storage = { get: vi.fn(async (key: string) => key === "task" ? task : undefined) };
    const coordinator = new Coordinator({ storage } as never, { ARTIFACTS: {} } as never);

    const diff = await coordinator.landingDiff();

    expect(io.workspace.head).toHaveBeenCalledOnce();
    expect(io.workspace.fetch).toHaveBeenCalledOnce();
    expect(io.workspace.mergeBase).toHaveBeenCalledWith("project-main-head", "task-base-head");
    expect(io.workspace.changedFiles).toHaveBeenCalledWith("common-ancestor", "task-base-head");
    expect(diff).toMatchObject({ base: "common-ancestor", head: "task-base-head", files: ["src/task.ts"], omitted: [] });
    expect(diff.unified).toContain("+task");
  });
});
