import { describe, expect, it } from "vitest";
import {
	DEMO_AGENTS,
	RUN_GIVES_UP_MS,
	RUN_MINUTES,
	RUNS_PER_DAY,
	type Registry,
	SLOT_LAPSES_MS,
	ended,
	refusal,
	repoName,
	started,
} from "../src/demo/run";
import { FakeStorage } from "./fakes/env";

const { DemoRun } = await import("../src/demo/demo-run");

// Honeycomb demo runs: GitHive's hosted agents build the game while someone watches. The registry lets one run at a
// time and a few a day; a run starts its repo's agents and watches for them to finish.

const NOW = Date.parse("2026-10-12T15:30:00.000Z");
const empty: Registry = { day: { date: "", started: 0 }, recent: [] };
const slot = (id: string, since = NOW) => ({ id, fullName: `ada/${id}`, since });

describe("the demo registry", () => {
	it("lets one run go at a time, until it ends or its slot lapses", () => {
		const one = started(empty, slot("honeycomb-1"));
		expect(refusal(one, NOW + 60_000)).toBe("a demo run is going already: watch it at ada/honeycomb-1");
		expect(refusal(ended(one, "honeycomb-1"), NOW + 60_000)).toBeNull();
		expect(refusal(one, NOW + SLOT_LAPSES_MS + 1)).toBeNull();
		// Another run's end doesn't free the slot.
		expect(ended(one, "other").running?.id).toBe("honeycomb-1");
	});

	it("starts at most a few a day, counting from each UTC day", () => {
		let registry = empty;
		for (let run = 0; run < RUNS_PER_DAY; run++)
			registry = ended(started(registry, slot(`r${run}`, NOW + run)), `r${run}`);
		expect(refusal(registry, NOW + 10)).toMatch(/today's 5 demo runs have happened/);
		expect(refusal(registry, NOW + 24 * 3600_000)).toBeNull();
		expect(registry.recent.map((run) => run.id)).toEqual(["r4", "r3", "r2", "r1", "r0"]);
	});

	it("names a run's repo for when it started", () => {
		expect(repoName(NOW)).toBe("honeycomb-202610121530");
	});
});

/** A run over a stand-in for its repo's hosted agents, whose accounts the test sets. */
function demo() {
	const agents: { name: string; done: boolean }[] = [];
	const started: unknown[] = [];
	let stopped = false;
	const released: string[] = [];
	const env = { DEMO_RUN: { getByName: () => ({ release: async (id: string) => void released.push(id) }) } };
	class TestRun extends DemoRun {
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
	return { run, storage, agents, started, released, stopped: () => stopped };
}

const begin = (run: InstanceType<typeof DemoRun>) =>
	run.begin({ id: "ada--honeycomb-1", repo: "ada--honeycomb-1", fullName: "ada/honeycomb-1", by: "ada" });

describe("a demo run", () => {
	it("starts its repo's hosted agents, and is done once each has stopped", async () => {
		const { run, agents, started, released } = demo();
		await begin(run);
		expect(started).toEqual([{ repo: "ada--honeycomb-1", count: DEMO_AGENTS, minutes: RUN_MINUTES, by: "ada" }]);
		agents.push({ name: "githive-forager", done: false }, { name: "githive-scout", done: true });
		await run.alarm();
		expect((await run.status())?.status).toBe("running");
		agents[0]!.done = true;
		await run.alarm();
		expect((await run.status())?.status).toBe("done");
		expect(released).toEqual(["ada--honeycomb-1"]);
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
		expect(released).toEqual(["ada--honeycomb-1"]);
	});
});
