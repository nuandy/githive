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
} from "../demo/run";
import { topLevel } from "../demo/demo-repo";
import { FakeStorage } from "../../test/fakes/env";

const { DemoRun } = await import("../demo/demo-run");

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

type SetUp = { repo: string; reset?: string; restore?: { required: number; verify: string[] } };

/**
 * A run over stand-ins for its repo's hosted agents, whose accounts the test sets, and for the repo's setup, which
 * gives `setUp` (or throws it, when it's an Error).
 */
type Gates = { required: number; verify: string[] };
type SetUpWith = (restore: () => Promise<Gates>) => Promise<SetUp>;

function demo(
	setUp: SetUp | Error | SetUpWith = { repo: "ada--honeycomb" },
	gates: Gates = { required: 1, verify: [] },
) {
	const agents: { name: string; done: boolean }[] = [];
	const started: unknown[] = [];
	let stopped = false;
	const released: string[] = [];
	// The reset's claim until it merges (which the first merge does here), and the settings the run sets.
	const reset = { claimed: true, merges: 0, settings: [] as unknown[] };
	const env = { DEMO_RUN: { getByName: () => ({ release: async (id: string) => void released.push(id) }) } };
	const stretches: string[] = [];
	const landings: { change: string; how: string }[] = [];
	class TestRun extends DemoRun {
		protected override async landings() {
			return landings;
		}
		protected override async startStretch(repo: string) {
			stretches.push(`${repo} after ${started.length} starts`);
		}
		protected override async setUp(_run: unknown, restore: () => Promise<Gates>) {
			if (setUp instanceof Error) throw setUp;
			if (typeof setUp === "function") return setUp(restore);
			return setUp;
		}
		protected override async currentGates() {
			return gates;
		}
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
	return { run, storage, agents, started, released, reset, stretches, landings, stopped: () => stopped };
}

/** Begins run 1 and lets its first alarm set it up. */
async function begin(run: InstanceType<typeof DemoRun>) {
	await run.begin({ id: "run-1", number: 1, repo: "ada--honeycomb", fullName: "ada/honeycomb", by: "ada" });
	await run.alarm();
}

describe("a demo run", () => {
	it("counts its pieces that landed, whatever its agents' own accounts say", async () => {
		const { run, landings } = demo();
		await begin(run);
		await run.alarm();
		// This run's pieces once each, not the reset, another run's or one put out.
		landings.push(
			{ change: "reset-1", how: "landed" },
			{ change: "storage-1", how: "landed" },
			{ change: "storage-1", how: "landed" },
			{ change: "scoring-1", how: "failed" },
			{ change: "storage-7", how: "landed" },
		);
		expect(await run.status()).toMatchObject({ landed: 1 });
	});

	it("sets itself up on its own alarm, not in the request, then starts its agents", async () => {
		const { run, started } = demo();
		await run.begin({ id: "run-1", number: 1, repo: "ada--honeycomb", fullName: "ada/honeycomb", by: "ada" });
		expect(await run.began()).toBe(true);
		expect(started).toEqual([]);
		expect((await run.status())?.settingUp).toBe(true);
		await run.alarm();
		expect(started).toEqual([
			{ repo: "ada--honeycomb", count: DEMO_AGENTS, minutes: RUN_MINUTES, by: "ada", payer: "githive" },
		]);
		expect((await run.status())?.settingUp).toBeUndefined();
	});

	it("fails, freeing the slot, when its repo can't be set up", async () => {
		const { run, started, released } = demo(new Error("[409] the reset couldn't claim the repo"));
		await begin(run);
		expect(started).toEqual([]);
		expect(await run.status()).toMatchObject({ status: "failed", error: "the reset couldn't claim the repo" });
		expect(released).toEqual(["run-1"]);
	});

	it("keeps the repo's approvals and checks before its reset changes them, to put back if setup fails", async () => {
		const kept = { required: 2, verify: ["npm test"] };
		const turnedOff = async (restore: () => Promise<Gates>) => {
			await restore();
			throw new Error("[500] the reset's push failed");
		};
		const { run, storage, reset, released } = demo(turnedOff, kept);
		await begin(run);
		expect(((await storage.get("run")) as { restore?: Gates }).restore).toEqual(kept);
		expect(reset.settings).toEqual([{ repo: "ada--honeycomb", ...kept }]);
		expect(await run.status()).toMatchObject({ status: "failed" });
		expect(released).toEqual(["run-1"]);
	});

	it("is done once each of its agents has stopped", async () => {
		const { run, agents, released } = demo();
		await begin(run);
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
		const restore = { required: 1, verify: ["npm test"] };
		const { run, agents, reset, started, stretches } = demo({ repo: "ada--honeycomb", reset: "reset-1", restore });
		// The last run's agents, all stopped, don't end this one.
		agents.push({ name: "githive-forager", done: true });
		await begin(run);
		expect(started).toEqual([]);
		await run.alarm();
		expect(reset.merges).toBe(1);
		expect((await run.status())?.status).toBe("running");
		expect(started).toEqual([]);
		await run.alarm();
		expect(reset.settings).toEqual([{ repo: "ada--honeycomb", ...restore }]);
		expect(started).toHaveLength(1);
		// Its stretch of work begins as its agents start, so the dashboard times this run alone.
		expect(stretches).toEqual(["ada--honeycomb after 0 starts"]);
		expect((await run.status())?.reset).toBeUndefined();
	});

	it("gives the repo its approvals back if it's stopped before its reset lands", async () => {
		const restore = { required: 2, verify: ["npm test"] };
		const { run, storage, reset, stopped } = demo({ repo: "ada--honeycomb", reset: "reset-1", restore });
		await begin(run);
		const state = (await storage.get("run")) as { startedAt: number };
		await storage.put("run", { ...state, startedAt: state.startedAt - RUN_GIVES_UP_MS - 1 });
		await run.alarm();
		expect(stopped()).toBe(true);
		expect(reset.settings).toContainEqual({ repo: "ada--honeycomb", ...restore });
	});
});

describe("the registry's running slot", () => {
	it("is free again when the run holding it never began, its request having failed first", async () => {
		const registryWith = (began: string[]) => {
			class TestRegistry extends DemoRun {
				protected override async runBegan(id: string) {
					return began.includes(id);
				}
			}
			const ctx = { storage: new FakeStorage(), blockConcurrencyWhile: <T>(work: () => Promise<T>) => work() };
			return new TestRegistry(ctx as never, {} as never);
		};
		const going = registryWith(["run-1"]);
		expect((await going.reserve({ fullName: "ada/honeycomb", since: NOW })).slot?.id).toBe("run-1");
		expect((await going.reserve({ fullName: "ada/honeycomb", since: NOW + 1 })).refused).toMatch(/going already/);
		expect((await going.runs()).running?.id).toBe("run-1");
		// Here run-1 never began: once its request has had time to begin it, the next run takes the slot.
		const lost = registryWith([]);
		await lost.reserve({ fullName: "ada/honeycomb", since: NOW });
		expect((await lost.runs()).running).toBeUndefined();
		expect((await lost.reserve({ fullName: "ada/honeycomb", since: NOW + 61_000 })).slot?.id).toBe("run-2");
	});

	it("isn't taken by a second request while the first is still beginning its run", async () => {
		class Beginning extends DemoRun {
			protected override async runBegan() {
				return false;
			}
		}
		const ctx = { storage: new FakeStorage(), blockConcurrencyWhile: <T>(work: () => Promise<T>) => work() };
		const registry = new Beginning(ctx as never, {} as never);
		expect((await registry.reserve({ fullName: "ada/honeycomb", since: NOW })).slot?.id).toBe("run-1");
		expect((await registry.reserve({ fullName: "ada/honeycomb", since: NOW + 500 })).refused).toMatch(/going already/);
	});
});
