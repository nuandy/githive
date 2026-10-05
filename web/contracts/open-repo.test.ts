import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { api, type Task } from "../src/api";
import { DashboardSidebar } from "../src/components/DashboardSidebar";
import { TaskHeader } from "../src/components/TaskHeader";
import { TaskSettings } from "../src/components/TaskSettings";

const task = {
	id: "open-example", repo: "example", goal: "Open changes on example", phase: "building", mode: "open", leaseMinutes: 30,
	verify: ["npm test"], review: { reviewers: ["tests"], required: 1, vetoes: ["security"] }, slices: [], checks: [], createdAt: "now",
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

	it("shows an open task without plan or approval actions, with its merge checks", () => {
		const header = renderToStaticMarkup(createElement(TaskHeader, { task, busy: false }));
		expect(header).toContain(">open<");
		expect(header).not.toMatch(/Plan|Approve/);
		const settings = renderToStaticMarkup(createElement(TaskSettings, { task }));
		expect(settings).toContain("npm test");
		expect(settings).toContain("1 approval required");
		expect(settings).toContain("security");
		expect(settings).toContain("30 min");
	});

	it("offers an open-a-repo form in place of task creation", () => {
		const html = renderToStaticMarkup(createElement(DashboardSidebar, {
			tasks: [], repos: [{ name: "example" }], selectedId: null, taskLoading: false, opening: false,
			onSelect: () => undefined, onOpenRepo: () => undefined,
		}));
		expect(html).toContain("Open a repo");
		expect(html).toContain("Open for agents");
		expect(html).toContain('<option value="example">');
		expect(html).not.toMatch(/Create and plan|Goal/);
	});
});
