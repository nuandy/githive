import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import type { CodeVisibilityApi } from "../src/dashboard-contract";

const codeApi = api as unknown as CodeVisibilityApi;

describe("dashboard code decision API", () => {
  it("loads contract contents, pinned slice and landing diffs, and posts a waiver reason", async () => {
    const responses = new Map<string, unknown>([
      ["/tasks/task%20%2F1/contracts", { files: [{ path: "test/contract.ts", content: "export interface Contract {}\n" }] }],
      ["/tasks/task%20%2F1/slices/slice%2Fone/diff", { base: "base-sha", head: "review-sha", unified: "--- a/file.ts\n+++ b/file.ts\n" }],
      ["/tasks/task%20%2F1/land-diff", { base: "project-sha", head: "task-sha", unified: "diff text\n" }],
      ["/tasks/task%20%2F1/slices/slice%2Fone/waive", { waived: true }],
    ]);
    const originalFetch = globalThis.fetch;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = responses.get(String(input));
      if (body === undefined) throw new Error(`Unexpected request: ${String(input)}`);
      return Response.json(body);
    });
    globalThis.fetch = request as unknown as typeof fetch;
    try {
      await expect(codeApi.contractFiles("task /1")).resolves.toEqual([
        { path: "test/contract.ts", content: "export interface Contract {}\n" },
      ]);
      await expect(codeApi.sliceDiff("task /1", "slice/one")).resolves.toMatchObject({ base: "base-sha", head: "review-sha", unified: expect.stringContaining("--- a/file.ts") });
      await expect(codeApi.landingDiff("task /1")).resolves.toMatchObject({ base: "project-sha", head: "task-sha", unified: "diff text\n" });
      await codeApi.waive("task /1", "slice/one", "Human accepts this review risk");

      expect(request.mock.calls.map(([input]) => String(input))).toEqual([...responses.keys()]);
      expect(request.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "GET", "GET", "POST"]);
      expect(JSON.parse(String(request.mock.calls[3][1]?.body))).toEqual({ reason: "Human accepts this review risk" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
