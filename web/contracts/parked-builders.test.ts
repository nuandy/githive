import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Live } from "../src/api";
import { SliceLanes } from "../src/components/SliceLanes";
const live = {
	task: {
		id: "t1", repo: "repo", goal: "goal", phase: "building", verify: [],
		review: { reviewers: [], required: 0, vetoes: [] }, checks: [], createdAt: "now",
		slices: [{ id: "ui", title: "UI", owns: ["src/ui/"], status: "building", touched: [], outOfLane: [], reviews: [], instructions: "" }],
		laneChangeRequests: [{ id: "r1", requester: "ui", owner: "api", path: "src/api/routes.ts", need: "Add route", reason: "UI needs endpoint", status: "answered", createdAt: "now", answer: "Added" }],
	},
	agents: [{ id: "ui", builder: { status: "parked", startedAt: "now", parkedAt: "2026-10-02T00:00:00.000Z", waitingRequestIds: ["r1"], turns: 1, toolCalls: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, log: [] }, reviewers: [] }],
} as unknown as Live;
describe("parked builder dashboard", () => {
	it("shows parked as a nonfailure with when and what it is waiting on", () => {
		const html = renderToStaticMarkup(createElement(SliceLanes, { live }));
		expect(html).toMatch(/parked/i);
		expect(html).toMatch(/src\/api\/routes\.ts/);
		expect(html).toMatch(/api/);
		expect(html).toMatch(/since|ago/i);
		expect(html).not.toMatch(/Needs a human:.*parked/i);
	});
});
