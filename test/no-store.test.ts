import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "test@example.com" })),
}));

const fetchFrom = (path: string, env: object = {}) =>
	worker.fetch(new Request(`https://githive.test${path}`), env as never, {} as never);

describe("browsers don't keep the API's answers", () => {
	it("marks a JSON answer no-store", async () => {
		const response = await fetchFrom("/api");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("marks a JSON error no-store too", async () => {
		const env = {
			ARTIFACTS: {
				list: async () => {
					throw new Error("listing failed");
				},
			},
		};
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await fetchFrom("/repos", env);

		expect(response.status).toBe(500);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("leaves the dashboard's files as the assets serve them", async () => {
		const env = {
			ASSETS: {
				fetch: async () =>
					new Response("export {}", {
						headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" },
					}),
			},
		};

		const response = await fetchFrom("/assets/index-abc123.js", env);

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
	});

	it("keeps the caching an answer chose for itself", async () => {
		const env = {
			ASSETS: {
				fetch: async () =>
					new Response("{}", { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } }),
			},
		};

		const response = await fetchFrom("/manifest.json", env);

		expect(response.headers.get("Cache-Control")).toBe("max-age=60");
	});
});
