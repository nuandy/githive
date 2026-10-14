import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DemoRunStatus } from "../api";
import { NOW, visibleText } from "../test/fixtures";
import { agentsOf, DemoCard, gameLanded, runWords, setUpOf } from "./DemoRun";

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
		expect(text).toContain("Watch a hive build Honeycomb (Demo Game)");
		expect(text).toContain("Nothing assigns the work");
		expect(text).toContain("Start a demo run");
	});

	it("is a line to put away for an account that has repositories", () => {
		const api = { start: async () => ({ id: "x", repo: "ada/x" }), runs: async () => ({ running: null }) };
		const html = renderToStaticMarkup(<DemoCard api={api} compact />);
		const text = visibleText(html);
		expect(text).toContain("Watch a hive build a game.");
		// Before the runs are read, it doesn't guess how many agents there are.
		expect(text).toMatch(/GitHive.s agents build Honeycomb, a word game/);
		expect(text).toContain("Start a demo run");
		expect(html).toContain('aria-label="Dismiss the demo"');
		expect(text).not.toContain("Nothing assigns the work");
	});

	it("says how a run is going, and how it ended", () => {
		expect(runWords(run(), NOW)).toBe(
			"Demo run 3, started by ada 10 minutes ago: 1 building, 1 reviewing, 1 of 13 pieces finished.",
		);
		expect(runWords(run({ status: "done", endedAt: NOW - 60_000 }), NOW)).toBe(
			"Demo run 3 finished 1 minute ago: 1 of 13 pieces finished.",
		);
	});

	it("counts what landed, which an agent that lost track of its piece doesn't miss", () => {
		const done = run({ status: "done", endedAt: NOW - 60_000, pieces: 2, landed: 2 });
		expect(runWords(done, NOW)).toBe("Demo run 3 finished 1 minute ago: 2 of 2 pieces finished.");
		expect(gameLanded(done)).toBe(true);
	});

	it("says when a run is setting up, and when one couldn't start", () => {
		expect(runWords(run({ settingUp: true }), NOW)).toBe(
			"Demo run 3, started by ada 10 minutes ago: setting the repo up for its agents.",
		);
		expect(runWords(run({ status: "failed", error: "the reset couldn't claim the repo" }), NOW)).toBe(
			"Demo run 3 couldn't start: the reset couldn't claim the repo.",
		);
	});

	it("says when the hive is reviewing the run's reset, before any piece", () => {
		expect(runWords(run({ reset: "reset-3" }), NOW)).toBe(
			"Demo run 3, started by ada 10 minutes ago: putting the starting files back (reset-3) before its agents start.",
		);
	});

	it("offers the game to play only once a run has finished with every piece landed", () => {
		const landed = (count: number) => Array.from({ length: count }, (_, at) => ({ piece: `p${at}`, at }));
		const all = [agent("githive-forager", { finished: landed(13), done: true })];
		expect(gameLanded(run({ status: "done", agents: all }))).toBe(true);
		expect(gameLanded(run({ status: "running", agents: all }))).toBe(false);
		expect(gameLanded(run({ status: "stopped", agents: all }))).toBe(false);
		const some = [agent("githive-forager", { finished: landed(12), done: true })];
		expect(gameLanded(run({ status: "done", agents: some }))).toBe(false);
	});

	it("opens a new run's repo once the run has set it up, or says why it couldn't", async () => {
		const answers = (...states: Partial<DemoRunStatus>[]) => {
			const queue = states.map((state) => ({ running: null, newest: run({ id: "run-4", ...state }) }));
			return { runs: async () => queue.shift() ?? queue.at(-1)! };
		};
		const waited: number[] = [];
		const wait = async (ms: number) => void waited.push(ms);
		expect(await setUpOf(answers({ settingUp: true }, { settingUp: true }, {}), "run-4", wait)).toBeUndefined();
		expect(waited).toHaveLength(2);
		const failed = answers({ settingUp: true }, { status: "failed", error: "the reset couldn't claim the repo" });
		expect(await setUpOf(failed, "run-4", wait)).toBe("the reset couldn't claim the repo");
		// The newest run being another one means this one isn't listed yet: it keeps asking.
		waited.length = 0;
		const other = { runs: async () => ({ running: null, newest: run({ id: "run-3" }) }) };
		expect(await setUpOf(other, "run-4", wait)).toBeUndefined();
		expect(waited).toHaveLength(60);
	});

	it("says how many agents a run starts, as the server counts them", () => {
		expect(agentsOf(11)).toBe("Eleven of GitHive's agents");
		expect(agentsOf(13, "own")).toBe("Thirteen of GitHive's own agents");
		expect(agentsOf(25)).toBe("25 of GitHive's agents");
		expect(agentsOf(undefined)).toBe("GitHive's agents");
		expect(agentsOf(0, "own")).toBe("GitHive's own agents");
	});
});
