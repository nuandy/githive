import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "../src/api";
import { LaneChangeRequests } from "../src/components/LaneChangeRequests";

describe("dashboard cross-lane requests", () => {
	it("shows pending and answered requests and their outcomes without a person identity", () => {
		const task = {
			id: "t1", repo: "repo", goal: "goal", phase: "building", verify: [],
			review: { reviewers: [], required: 0, vetoes: [] }, slices: [], checks: [], createdAt: "now",
			laneChangeRequests: [
				{ id: "r1", requester: "ui", owner: "api", path: "src/api/routes.ts", need: "Register route", reason: "UI needs the endpoint", status: "pending", createdAt: "now" },
				{ id: "r2", requester: "api", owner: "core", path: "src/core/types.ts", need: "Add type", reason: "Shared contract", status: "answered", answer: "Added the type", createdAt: "then", answeredAt: "now" },
			],
		} as unknown as Task;
		const html = renderToStaticMarkup(createElement(LaneChangeRequests, { task }));
		expect(html).toContain("Pending");
		expect(html).toContain("Answered");
		expect(html).toContain("src/api/routes.ts");
		expect(html).toContain("Added the type");
		expect(html).not.toContain("human@example.com");
	});
});
