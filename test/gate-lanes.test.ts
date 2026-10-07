import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate's warm-up of a repo's check containers, without containers: which
// lanes it warms, when, and how it reports their warmth.

const { Gate } = await import("../src/gate");

describe("warming a coordinator-free repo's lanes", () => {
	it("returns at once, then warms this Gate and the three beside it in the background", async () => {
		const storage = new FakeStorage();
		const lanes = new Map<string, ReturnType<typeof vi.fn>>();
		const env = { GATE: { getByName: (name: string) => ({ warm: lanes.set(name, lanes.get(name) ?? vi.fn(async () => undefined)).get(name)! }) } };
		const gate = new Gate({ storage, setAlarm: undefined } as never, env as never);
		const input = { repo: "express", branch: "master", base: { remote: "https://git.test/express.git", token: "read" }, checks: ["npm install", "npm test"] };
		await gate.warmLanes(input);
		expect(storage.alarm).not.toBeNull();
		expect(lanes.size).toBe(0);
		await gate.alarm();
		expect([...lanes.keys()].sort()).toEqual(["free:express:lane:1", "free:express:lane:2", "free:express:lane:3"]);
		const { repo: _repo, ...warmed } = input;
		for (const warm of lanes.values()) expect(warm).toHaveBeenCalledWith(warmed);
		expect(await storage.get("warmLanes")).toBeUndefined();
	});

	it("doesn't warm a repo with no checks", async () => {
		const storage = new FakeStorage();
		const gate = new Gate({ storage } as never, {} as never);
		await gate.warmLanes({ repo: "express", base: { remote: "r", token: "t" }, checks: [] });
		expect(storage.alarm).toBeNull();
	});
});

describe("a coordinator-free repo's lanes, warm or not", () => {
	it("says per lane whether it runs, when it last warmed, and whether it's warming", async () => {
		const storage = new FakeStorage();
		const others = new Map<string, { running: boolean; warmedAt: number | null; warming: boolean }>([
			["free:express:lane:1", { running: true, warmedAt: 2, warming: false }],
			["free:express:lane:2", { running: true, warmedAt: null, warming: true }],
			["free:express:lane:3", { running: false, warmedAt: null, warming: false }],
		]);
		const env = { GATE: { getByName: (name: string) => ({ warmth: async () => others.get(name) }) } };
		const gate = new Gate({ storage } as never, env as never);
		await storage.put("warmingSince", 5);
		await storage.put("warmedAt", 9);
		expect(await gate.lanes("express")).toEqual([
			{ lane: 0, running: false, warmedAt: 9, warming: false },
			{ lane: 1, running: true, warmedAt: 2, warming: false },
			{ lane: 2, running: true, warmedAt: null, warming: true },
			{ lane: 3, running: false, warmedAt: null, warming: false },
		]);
	});
});
