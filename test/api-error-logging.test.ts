import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "test@example.com" })),
}));

afterEach(() => vi.restoreAllMocks());

describe("API error logging", () => {
	it("logs the underlying unexpected error object while returning a 500", async () => {
		const failure = new Error("approval failed once");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const env = {
			COORDINATOR: {
				idFromName: (id: string) => id,
				get: () => ({ state: async () => { throw failure; } }),
			},
			// A task the index doesn't list as elected: run by its Coordinator.
			TASK_INDEX: { getByName: () => ({ get: async () => null }) },
		};

		const response = await worker.fetch(new Request("https://blueprint.test/tasks/task-1"), env as never, {} as never);

		expect(response.status).toBe(500);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("API"), failure);
	});
});
