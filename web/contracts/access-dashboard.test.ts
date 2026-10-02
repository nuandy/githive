import { describe, expect, it, vi } from "vitest";
import * as apiModule from "../src/api";
import { api } from "../src/api";
import * as components from "../src/components";

describe("dashboard Cloudflare Access behavior", () => {
	it("does not expose API-token storage or a token-settings form", () => {
		expect(apiModule).not.toHaveProperty("getToken");
		expect(apiModule).not.toHaveProperty("setToken");
		expect(components).not.toHaveProperty("TokenSettings");
	});

	it("makes same-origin API calls without an API bearer token", async () => {
		const originalFetch = globalThis.fetch;
		const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json([]));
		globalThis.fetch = request as unknown as typeof fetch;
		try {
			await api.tasks();
			expect(new Headers(request.mock.calls[0][1]?.headers).get("Authorization")).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
