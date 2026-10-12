import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DemoRunStatus } from "../api";
import { NOW, visibleText } from "../test/fixtures";
import { DemoCard, runWords } from "./DemoRun";

// Honeycomb demo runs on the dashboard: the card that starts one, and the words its Hive tab's banner says.

const agent = (name: string, more: Partial<DemoRunStatus["agents"][number]> = {}) => ({
	name,
	finished: [],
	reviewed: 0,
	done: false,
	...more,
});
const run = (more: Partial<DemoRunStatus> = {}): DemoRunStatus => ({
	id: "run-3",
	number: 3,
	fullName: "nuandy/honeycomb",
	by: "ada",
	startedAt: NOW - 10 * 60_000,
	status: "running",
	pieces: 13,
	agents: [
		agent("githive-forager", { change: "puzzle", finished: [{ piece: "scoring", at: NOW }] }),
		agent("githive-scout", { reviewing: { change: "puzzle" } }),
		agent("githive-nurse"),
	],
	...more,
});

describe("a demo run on the dashboard", () => {
	it("offers to start one, saying what happens", () => {
		const api = { start: async () => ({ id: "x", repo: "ada/x" }), runs: async () => ({ running: null }) };
		const text = visibleText(renderToStaticMarkup(<DemoCard api={api} />));
		expect(text).toContain("Watch a hive build Honeycomb");
		expect(text).toContain("Nothing assigns the work");
		expect(text).toContain("Start a demo run");
	});

	it("says how a run is going, and how it ended", () => {
		expect(runWords(run(), NOW)).toBe(
			"Demo run 3, started by ada 10 minutes ago: 1 building, 1 reviewing, 1 of 13 pieces finished.",
		);
		expect(runWords(run({ status: "done", endedAt: NOW - 60_000 }), NOW)).toBe(
			"Demo run 3 finished 1 minute ago: 1 of 13 pieces finished.",
		);
	});

	it("says when the hive is reviewing the run's reset, before any piece", () => {
		expect(runWords(run({ reset: "reset-3" }), NOW)).toBe(
			"Demo run 3, started by ada 10 minutes ago: the hive reviews reset-3, which puts the starting files back.",
		);
	});
});
