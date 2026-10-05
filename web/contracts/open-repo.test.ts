import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { api, type Task } from "../src/api";
import { RepoSettings } from "../src/components/RepoSettings";

const task = {
	id: "open-example", repo: "example", goal: "Open changes on example", phase: "building", mode: "open", leaseMinutes: 30,
	verify: ["npm test"], review: { reviewers: ["tests", "security"], required: 1, vetoes: ["security"] }, slices: [], checks: [], createdAt: "now",
} as unknown as Task;

describe("open-mode dashboard", () => {
	it("opens a repo for agents and normalizes the returned task", async () => {
		const originalFetch = globalThis.fetch;
		const request = vi.fn(async () => Response.json({ id: "open-example", repo: "example", goal: "Open changes on example", phase: "building" }, { status: 201 }));
		globalThis.fetch = request as unknown as typeof fetch;
		try {
			const opened = await api.openRepo("team/example");
			expect(opened).toMatchObject({ id: "open-example", slices: [], checks: [], verify: [], laneChangeRequests: [] });
			expect(request).toHaveBeenCalledTimes(1);
			const [input, init] = request.mock.calls[0] as unknown as [string, RequestInit];
			expect(input).toBe("/repos/team%2Fexample/open");
			expect(init.method).toBe("POST");
			expect(JSON.parse(String(init.body))).toEqual({});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("no longer exposes planned-mode calls", () => {
		for (const name of ["create", "plan", "approve", "build", "land", "contractFiles", "landingDiff"]) expect(api).not.toHaveProperty(name);
	});

	it("shows a repo's merge checks, review policy and claim expiry, read-only", () => {
		const settings = renderToStaticMarkup(createElement(RepoSettings, { task }));
		expect(settings).toContain("npm test");
		expect(settings).toContain("1 approval required");
		expect(settings).toContain("security");
		expect(settings).toContain("30 minutes without activity");
		expect(settings).not.toMatch(/<(input|textarea|select)\b/);
	});
});
