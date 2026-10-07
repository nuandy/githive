import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate's warm-up of a repo's check containers, without containers: which
// lanes it warms, when, and how it reports their warmth.

const { Gate } = await import("../src/gate");

describe("warming a repo's lanes", () => {
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
		expect([...lanes.keys()].sort()).toEqual(["repo:express:lane:1", "repo:express:lane:2", "repo:express:lane:3"]);
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

describe("a repo's lanes, warm or not", () => {
	it("says per lane whether it runs, when it last warmed, and whether it's warming", async () => {
		const storage = new FakeStorage();
		const others = new Map<string, { running: boolean; warmedAt: number | null; warming: boolean }>([
			["repo:express:lane:1", { running: true, warmedAt: 2, warming: false }],
			["repo:express:lane:2", { running: true, warmedAt: null, warming: true }],
			["repo:express:lane:3", { running: false, warmedAt: null, warming: false }],
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

describe("installing a Node project's dependencies before its checks", () => {
	it("installs first with npm ci from an npm lockfile, or npm install without one", async () => {
		const { withInstall } = await import("../src/gate");
		expect(withInstall(["npm test"], { packageJson: true, npmLockfile: true })).toEqual(["npm ci", "npm test"]);
		expect(withInstall(["npm test"], { packageJson: true, npmLockfile: false })).toEqual(["npm install", "npm test"]);
	});

	it("leaves the checks as they are when one installs, or the project isn't a Node one", async () => {
		const { withInstall } = await import("../src/gate");
		expect(withInstall(["npm install", "npm test"], { packageJson: true, npmLockfile: true })).toEqual(["npm install", "npm test"]);
		expect(withInstall(["pnpm install --frozen-lockfile", "pnpm test"], { packageJson: true, npmLockfile: false })).toEqual(["pnpm install --frozen-lockfile", "pnpm test"]);
		expect(withInstall(["cargo test"], { packageJson: false, npmLockfile: false })).toEqual(["cargo test"]);
	});
});
