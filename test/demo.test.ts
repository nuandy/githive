import { describe, expect, it } from "vitest";
import {
	DEMO_AGENTS,
	RUN_GIVES_UP_MS,
	RUN_MINUTES,
	RUNS_PER_DAY,
	type Registry,
	SLOT_LAPSES_MS,
	ended,
	nextRun,
	refusal,
	runBacklog,
	started,
} from "../src/demo/run";
import { topLevel } from "../src/demo/demo-repo";
import { FakeStorage } from "./fakes/env";

const { DemoRun } = await import("../src/demo/demo-run");

// Honeycomb demo runs: GitHive's hosted agents build the game in the one demo repo while someone watches. The registry
// lets one run at a time and up to 100 a day, and numbers them; a run starts the repo's agents, lands its reset once
// the hive approves it, and watches for the agents to finish.

const NOW = Date.parse("2026-10-12T15:30:00.000Z");
const empty: Registry = { day: { date: "", started: 0 }, recent: [] };
const slot = (id: string, since = NOW, number = 1) => ({ id, number, fullName: "ada/honeycomb", since });

describe("the demo registry", () => {
	it("lets one run go at a time, until it ends or its slot lapses", () => {
		const one = started(empty, slot("honeycomb-1"));
		expect(refusal(one, NOW + 60_000)).toBe("a demo run is going already: watch it at ada/honeycomb");
		expect(refusal(ended(one, "honeycomb-1"), NOW + 60_000)).toBeNull();
		expect(refusal(one, NOW + SLOT_LAPSES_MS + 1)).toBeNull();
		// Another run's end doesn't free the slot.
		expect(ended(one, "other").running?.id).toBe("honeycomb-1");
	});

	it("starts at most 100 a day, counting from each UTC day", () => {
		let registry = empty;
		for (let run = 0; run < RUNS_PER_DAY; run++)
			registry = ended(started(registry, slot(`r${run}`, NOW + run, nextRun(registry))), `r${run}`);
		expect(refusal(registry, NOW + 10)).toMatch(/today's 100 demo runs have happened/);
		expect(refusal(registry, NOW + 24 * 3600_000)).toBeNull();
		// Only the latest 20 are kept, newest first.
		expect(registry.recent).toHaveLength(20);
		expect(registry.recent[0]?.id).toBe("r99");
		expect(registry.recent[19]?.id).toBe("r80");
		expect(nextRun(registry)).toBe(RUNS_PER_DAY + 1);
	});
});

describe("starting a run over in the one demo repo", () => {
	it("gives each run's pieces ids of their own, and the ones they land after too", () => {
		const pieces = [
			{ id: "words", title: "Words", intent: "w", paths: ["src/words.js"] },
			{ id: "app", title: "App", intent: "a", paths: ["src/main.js"], landsAfter: ["words"] },
		];
		expect(runBacklog(pieces, 3)).toEqual([
			{ id: "words-3", title: "Words", intent: "w", paths: ["src/words.js"] },
			{ id: "app-3", title: "App", intent: "a", paths: ["src/main.js"], lands_after: ["words-3"] },
		]);
	});

	it("claims the whole repo for its reset: every top-level file and folder, before and after", () => {
		const paths = ["README.md", "src/main.js", "src/board.js", "test/board.test.js", "styles/game.css", "CHANGES.md"];
		expect(topLevel(paths)).toEqual(["CHANGES.md", "README.md", "src/", "styles/", "test/"]);
	});
});

/** A run over a stand-in for its repo's hosted agents, whose accounts the test sets. */
function demo() {
	const agents: { name: string; done: boolean }[] = [];
	const started: unknown[] = [];
	let stopped = false;
	const released: string[] = [];
	// The reset's claim until it merges (which the first merge does here), and the settings the run sets.
	const reset = { claimed: true, merges: 0, settings: [] as unknown[] };
	const env = { DEMO_RUN: { getByName: () => ({ release: async (id: string) => void released.push(id) }) } };
	class TestRun extends DemoRun {
		protected override async callTool(name: string, args: Record<string, unknown>) {
			if (name === "settings") return void reset.settings.push(args);
			if (name === "merge") {
				reset.merges++;
				reset.claimed = false;
				return { ok: true };
			}
			return reset.claimed ? { claim: {} } : {};
		}
		protected override hiveOf() {
			return {
				start: async (hive: unknown) => void started.push(hive),
				status: async () => ({ agents }),
				stopAll: async () => void (stopped = true),
			} as never;
		}
	}
	const run = new TestRun({ storage: new FakeStorage() } as never, env as never);
	const storage = (run as unknown as { ctx: { storage: FakeStorage } }).ctx.storage;
	return { run, storage, agents, started, released, reset, stopped: () => stopped };
}

const begin = (run: InstanceType<typeof DemoRun>, reset?: string) =>
	run.begin({
		id: "run-1",
		number: 1,
		repo: "ada--honeycomb",
		fullName: "ada/honeycomb",
		by: "ada",
		...(reset ? { reset } : {}),
	});

describe("a demo run", () => {
	it("starts its repo's hosted agents, and is done once each has stopped", async () => {
		const { run, agents, started, released } = demo();
		await begin(run);
		expect(started).toEqual([{ repo: "ada--honeycomb", count: DEMO_AGENTS, minutes: RUN_MINUTES, by: "ada" }]);
		agents.push({ name: "githive-forager", done: false }, { name: "githive-scout", done: true });
		await run.alarm();
		expect((await run.status())?.status).toBe("running");
		agents[0]!.done = true;
		await run.alarm();
		expect((await run.status())?.status).toBe("done");
		expect(released).toEqual(["run-1"]);
	});

	it("stops its agents long past its time", async () => {
		const { run, storage, agents, released, stopped } = demo();
		await begin(run);
		agents.push({ name: "githive-forager", done: false });
		const state = (await storage.get("run")) as { startedAt: number };
		await storage.put("run", { ...state, startedAt: state.startedAt - RUN_GIVES_UP_MS - 1 });
		await run.alarm();
		expect((await run.status())?.status).toBe("stopped");
		expect(stopped()).toBe(true);
		expect(released).toEqual(["run-1"]);
	});

	it("lands its reset first, gives the repo its approvals back, and only then starts its agents", async () => {
		const { run, agents, reset, started } = demo();
		await run.begin({
			id: "run-2",
			number: 2,
			repo: "ada--honeycomb",
			fullName: "ada/honeycomb",
			by: "ada",
			reset: "reset-2",
			restore: { required: 1, verify: ["npm test"] },
		});
		// The last run's agents, all stopped, don't end this one.
		agents.push({ name: "githive-forager", done: true });
		expect(started).toEqual([]);
		await run.alarm();
		expect(reset.merges).toBe(1);
		expect((await run.status())?.status).toBe("running");
		expect(started).toEqual([]);
		await run.alarm();
		expect(reset.settings).toEqual([{ repo: "ada--honeycomb", required: 1, verify: ["npm test"] }]);
		expect(started).toHaveLength(1);
		expect((await run.status())?.reset).toBeUndefined();
	});

	it("gives the repo its approvals back if it's stopped before its reset lands", async () => {
		const { run, storage, reset, stopped } = demo();
		await begin(run, "reset-1");
		const state = (await storage.get("run")) as { startedAt: number };
		const restore = { required: 2, verify: ["npm test"] };
		await storage.put("run", { ...state, restore, startedAt: state.startedAt - RUN_GIVES_UP_MS - 1 });
		await run.alarm();
		expect(stopped()).toBe(true);
		expect(reset.settings).toContainEqual({ repo: "ada--honeycomb", ...restore });
	});
});
