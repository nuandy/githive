import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

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
		};

		const response = await worker.fetch(new Request("https://blueprint.test/tasks/task-1"), env as never, {} as never);

		expect(response.status).toBe(500);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("API"), failure);
	});
});
