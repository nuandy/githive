import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "test@example.com" })),
}));

afterEach(() => vi.restoreAllMocks());

describe("API error logging", () => {
	it("logs the underlying unexpected error object while returning a 500", async () => {
		const failure = new Error("listing failed");
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const env = {
			ARTIFACTS: {
				list: async () => {
					throw failure;
				},
			},
		};

		const response = await worker.fetch(new Request("https://githive.test/repos"), env as never, {} as never);

		expect(response.status).toBe(500);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("API"), failure);
		// The reply names the logged error by its id, not by what failed underneath.
		const { error } = (await response.json()) as { error: string };
		expect(error).not.toContain("listing failed");
		const id = /error ([0-9a-f]{8})/.exec(error)?.[1];
		expect(errorLog).toHaveBeenCalledWith(`API error ${id}`, failure);
	});
});
