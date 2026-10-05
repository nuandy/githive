import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { TaskIndex } = await import("../src/task-index");

// The dashboard's list of tasks, which for elected tasks also notes who leads:
// a hint the Worker uses to reach the leader in one hop. Correctness never
// depends on it; a stale hint costs one fallback through the change's own peer.

const ref = { id: "t1", repo: "project", goal: "Open changes", createdAt: "2026-10-04T00:00:00.000Z", elected: true };

describe("the task index's leader hint", () => {
	it("records the leader a term's winner reports, and clears it when that leader resigns", async () => {
		const index = new TaskIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.add(ref);
		await index.hintLeader("t1", "t1--a", 1);
		expect(await index.get("t1")).toMatchObject({ leader: { name: "t1--a", term: 1 } });
		await index.hintLeader("t1", null, 1);
		expect(await index.get("t1")).toMatchObject({ leader: { name: null, term: 1 } });
	});

	it("never lets an older term's report overwrite a newer one", async () => {
		const index = new TaskIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.add(ref);
		await index.hintLeader("t1", "t1--b", 2);
		await index.hintLeader("t1", "t1--a", 1);
		await index.hintLeader("t1", null, 1);
		expect(await index.get("t1")).toMatchObject({ leader: { name: "t1--b", term: 2 } });
	});

	it("keeps a summary per task and coordinator-free repo, merging updates and adding merges", async () => {
		const index = new TaskIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.add(ref);
		await index.addFree("docs");
		await index.summarize("task:t1", { open: 2, merged: 1, lastActivity: "2026-10-06T10:00:00.000Z" });
		await index.summarize("task:t1", { open: 1 });
		await index.summarize("free:docs", { open: 3 });
		await index.summarize("free:docs", { mergedBy: 1, lastActivity: "2026-10-06T11:00:00.000Z" });
		const { tasks, free } = await index.summaries();
		expect(tasks).toEqual([{ ...ref, summary: { open: 1, merged: 1, lastActivity: "2026-10-06T10:00:00.000Z" } }]);
		expect(free).toEqual([{ repo: "docs", since: expect.any(String), summary: { open: 3, merged: 1, lastActivity: "2026-10-06T11:00:00.000Z" } }]);
		await index.remove("t1");
		expect((await index.summaries()).tasks).toEqual([]);
	});

	it("ignores a hint for a task it doesn't list", async () => {
		const index = new TaskIndex({ storage: new FakeStorage() } as never, {} as never);
		await index.hintLeader("nope", "x", 1);
		expect(await index.get("nope")).toBeNull();
	});
});
