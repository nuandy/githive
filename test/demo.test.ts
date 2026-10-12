import { describe, expect, it } from "vitest";
import {
	RUN_MS,
	RUNS_PER_DAY,
	type Registry,
	SLOT_LAPSES_MS,
	WORKERS,
	ended,
	refusal,
	repoName,
	started,
} from "../src/demo/run";
import { FakeStorage } from "./fakes/env";

const { DemoRun } = await import("../src/demo/demo-run");

// Honeycomb demo runs: GitHive's hosted agents build the game while someone watches. The registry lets one run at a
// time and a few a day; a run's workers each take the first free piece in their own order, as any agent does.

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

type Piece = { id: string; title: string; intent: string; paths: string[] };

/**
 * A run whose toolkit is a few maps: pieces, who claims them, and what merged. A piece's claim goes when the test
 * lands it. Each worker sees the free pieces in an order of its own, as backlog gives them.
 */
function demoRun(pieces: Piece[], options: { refuse?: string[]; builderFails?: string[] } = {}) {
	const storage = new FakeStorage();
	const claimed = new Map<string, string>();
	const merged = new Set<string>();
	const builders: string[] = [];
	const released: string[] = [];
	const registryReleased: string[] = [];
	const env = { DEMO_RUN: { getByName: () => ({ release: async (id: string) => void registryReleased.push(id) }) } };
	class TestRun extends DemoRun {
		protected override async callTool(name: string, args: Record<string, unknown>) {
			const change = String(args.change ?? "");
			if (name === "claims") return [...claimed].map(([piece, agent]) => ({ change: piece, agent }));
			if (name === "claim") {
				if (options.refuse?.includes(change)) return { ok: false, reasons: ["overlaps"] };
				claimed.set(change, String(args.agent));
				return { ok: true };
			}
			if (name === "release") return void (claimed.delete(change), released.push(change));
			if (name === "backlog") {
				const free = pieces.filter((piece) => !claimed.has(piece.id) && !merged.has(piece.id));
				const turn = WORKERS.indexOf(String(args.agent)) % Math.max(1, free.length);
				const open = [...free.slice(turn), ...free.slice(0, turn)];
				const waiting = [...claimed.keys()].map((id) => ({ id, reason: "claimed" }));
				return { open, waiting };
			}
			throw new Error(`no ${name} here`);
		}
		protected override async startBuilder(_repo: string, change: string) {
			if (options.builderFails?.includes(change)) throw new Error("no container");
			builders.push(change);
		}
	}
	const run = new TestRun({ storage } as never, env as never);
	const land = (piece: string) => {
		claimed.delete(piece);
		merged.add(piece);
	};
	return { run, claimed, builders, released, registryReleased, land };
}

const pieces = (...ids: string[]) => ids.map((id) => ({ id, title: id, intent: `build ${id}`, paths: [`src/${id}/`] }));
const begin = (run: InstanceType<typeof DemoRun>) =>
	run.begin({ id: "ada--honeycomb-1", repo: "ada--honeycomb-1", fullName: "ada/honeycomb-1", by: "ada" });

describe("a demo run", () => {
	it("gives each idle worker the first free piece in its own order, and starts a builder on it", async () => {
		const { run, claimed, builders } = demoRun(pieces("a", "b", "c"));
		await begin(run);
		await run.alarm();
		expect(builders.sort()).toEqual(["a", "b", "c"]);
		expect(new Set(claimed.values()).size).toBe(3);
		const state = await run.status();
		expect(state?.workers.filter((worker) => worker.change)).toHaveLength(3);
	});

	it("notes what landed, gives its worker more, and ends done once everything has landed", async () => {
		const { run, land, registryReleased } = demoRun(pieces("a"));
		await begin(run);
		await run.alarm();
		const builder = (await run.status())?.workers.find((worker) => worker.change === "a")?.name;
		land("a");
		await run.alarm();
		const state = await run.status();
		expect(state?.finished).toMatchObject([{ piece: "a", worker: builder }]);
		expect(state?.status).toBe("done");
		expect(registryReleased).toEqual(["ada--honeycomb-1"]);
	});

	it("leaves a refused claim for later, and frees a claim whose builder didn't start", async () => {
		const { run, builders, released } = demoRun(pieces("a", "b"), { refuse: ["a"], builderFails: ["b"] });
		await begin(run);
		await run.alarm();
		expect(builders).toEqual([]);
		expect(released).toContain("b");
		expect((await run.status())?.workers.every((worker) => !worker.change)).toBe(true);
	});

	it("takes nothing new once its time is up, and stops when the last builder is done", async () => {
		const { run, builders, land } = demoRun(pieces("a", "b", "c", "d", "e", "f", "g"));
		await begin(run);
		await run.alarm();
		expect(builders).toHaveLength(6);
		const state = (await run.status())!;
		await (run as unknown as { ctx: { storage: FakeStorage } }).ctx.storage.put("run", {
			...state,
			startedAt: Date.now() - RUN_MS - 1,
		});
		for (const piece of builders) land(piece);
		await run.alarm();
		expect(builders).toHaveLength(6);
		expect((await run.status())?.status).toBe("stopped");
	});
});
