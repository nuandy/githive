import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate's warm-up of a repo's check containers, without containers: which
// lanes it warms, when, and how it reports their warmth.

const { Gate } = await import("../src/gate");

describe("warming a repo's lanes", () => {
	it("returns at once, then warms this Gate alone in the background: the lanes beside it start when a batch needs them", async () => {
		const storage = new FakeStorage();
		const lanes = new Map<string, ReturnType<typeof vi.fn>>();
		const env = { GATE: { getByName: (name: string) => ({ warm: lanes.set(name, lanes.get(name) ?? vi.fn(async () => undefined)).get(name)! }) } };
		const gate = new Gate({ storage, setAlarm: undefined } as never, env as never);
		const input = { repo: "express", branch: "master", base: { remote: "https://git.test/express.git", token: "read" }, checks: ["npm install", "npm test"] };
		await gate.warmLanes(input);
		expect(storage.alarm).not.toBeNull();
		expect(lanes.size).toBe(0);
		await gate.alarm();
		expect(lanes.size).toBe(0);
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
		const others = new Map<string, { running: boolean; size: string; warmedAt: number | null; warming: boolean }>([
			["repo:express:lane:1", { running: true, size: "small", warmedAt: 2, warming: false }],
			["repo:express:lane:2", { running: true, size: "large", warmedAt: null, warming: true }],
			["repo:express:lane:3", { running: false, size: "small", warmedAt: null, warming: false }],
		]);
		const env = { GATE: { getByName: (name: string) => ({ warmth: async () => others.get(name) }) } };
		const gate = new Gate({ storage } as never, env as never);
		await storage.put("warmingSince", 5);
		await storage.put("warmedAt", 9);
		expect(await gate.lanes("express")).toEqual([
			{ lane: 0, running: false, size: "small", warmedAt: 9, warming: false },
			{ lane: 1, running: true, size: "small", warmedAt: 2, warming: false },
			{ lane: 2, running: true, size: "large", warmedAt: null, warming: true },
			{ lane: 3, running: false, size: "small", warmedAt: null, warming: false },
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

describe("a check container's size", () => {
	it("moves up only for a command killed for memory, not one killed at its time limit", async () => {
		const { outOfMemory } = await import("../src/container");
		expect(outOfMemory(137, 12_000, 600)).toBe(true);
		expect(outOfMemory(137, 600_000, 600)).toBe(false);
		expect(outOfMemory(1, 12_000, 600)).toBe(false);
	});
});

describe("stopping a check container once nothing needs it", () => {
	const start = 1_000_000;
	const running = () => {
		const storage = new FakeStorage();
		const container = { running: true, destroy: vi.fn(async () => void (container.running = false)) };
		const gate = new Gate({ storage, container } as never, {} as never);
		// As the runtime does: an alarm that fires is gone by the time its handler runs.
		const fire = async () => {
			storage.alarm = null;
			await gate.alarm();
		};
		return { storage, container, gate, fire };
	};
	const warmRequest = { repo: "express", base: { remote: "r", token: "t" }, checks: ["npm test"] };

	it("may stop a grace after its last run, and not before a merge it expects is due", async () => {
		const { stopAt, GRACE_MS } = await import("../src/gate");
		expect(stopAt(start, {})).toBe(start + GRACE_MS);
		expect(stopAt(start, { "c-1": start + 180_000, "c-2": start + 90_000 })).toBe(start + 180_000);
	});

	it("waits for an expected merge, then stops a grace after it lands, not minutes later", async () => {
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const { EXPECT_MS, GRACE_MS } = await import("../src/gate");
			const { storage, container, gate, fire } = running();
			await storage.put("lastActive", start);
			await gate.warmLanes({ ...warmRequest, expect: "checked", key: "c-1" });
			await storage.delete("warmLanes");
			// Still waiting for c-1: the container stays up and looks again when it's due.
			await fire();
			expect(container.destroy).not.toHaveBeenCalled();
			expect(storage.alarm).toBe(start + EXPECT_MS.checked);
			// c-1 lands two minutes in: a grace after the last run, the container goes.
			vi.setSystemTime(start + 120_000);
			await storage.put("lastActive", start + 120_000);
			await gate.lineDone("c-1");
			expect(storage.alarm).toBe(start + 120_000 + GRACE_MS);
			vi.setSystemTime(start + 120_000 + GRACE_MS);
			await fire();
			expect(container.destroy).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops when an expected merge never comes, at its deadline", async () => {
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const { EXPECT_MS } = await import("../src/gate");
			const { storage, container, gate, fire } = running();
			await storage.put("lastActive", start);
			await gate.warmLanes({ ...warmRequest, expect: "approved", key: "abc123" });
			await storage.delete("warmLanes");
			vi.setSystemTime(start + EXPECT_MS.approved);
			await fire();
			expect(container.destroy).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops a grace after its claim is released, instead of waiting for the merge", async () => {
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const { GRACE_MS } = await import("../src/gate");
			const { storage, container, gate, fire } = running();
			await storage.put("lastActive", start);
			await gate.warmLanes({ ...warmRequest, expect: "checked", key: "c-1" });
			await storage.delete("warmLanes");
			await gate.notExpecting("c-1");
			vi.setSystemTime(start + GRACE_MS);
			await fire();
			expect(container.destroy).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

/** A container that runs every command successfully, unless `fails` picks it out. */
function fakeContainer(fails: (cmd: string[]) => boolean = () => false) {
	const container = {
		running: false,
		starts: [] as Record<string, unknown>[],
		snapshots: 0,
		start(options: Record<string, unknown>) {
			container.starts.push(options);
			container.running = true;
		},
		destroy: vi.fn(async () => void (container.running = false)),
		setInactivityTimeout: vi.fn(async () => undefined),
		exec: async (cmd: string[]) => ({ output: async () => ({ exitCode: fails(cmd) ? 1 : 0, stdout: new Uint8Array() }) }),
		snapshotContainer: async () => ({ id: `snap-${++container.snapshots}`, size: 123e6 }),
	};
	return container;
}

describe("a repo's snapshot", () => {
	const snapshot = { id: "s1", size: 1, at: 1_000, lockHash: "l1" };

	it("is due when there's none, the dependencies changed, or it's a week old", async () => {
		const { snapshotDue } = await import("../src/gate");
		expect(snapshotDue(null, { lockHash: "l1" })).toBe(true);
		expect(snapshotDue(snapshot, { lockHash: "l1" }, 2_000)).toBe(false);
		expect(snapshotDue(snapshot, { lockHash: "l2" }, 2_000)).toBe(true);
		expect(snapshotDue(snapshot, { lockHash: "l1", depsHash: "d1" }, 2_000)).toBe(true);
		expect(snapshotDue(snapshot, { lockHash: "l1" }, 1_000 + 7 * 24 * 3600_000)).toBe(true);
	});

	it("starts a container in seconds, and an unusable one falls back to the image", async () => {
		const { bootContainer, IMAGE } = await import("../src/container");
		const restored = fakeContainer();
		expect(await bootContainer(restored as never, "small", snapshot)).toBe("restored");
		expect(restored.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "s1" } })]);
		// Started without its checkout (expired, say): destroyed, and started from the image with git installed.
		const unusable = fakeContainer((cmd) => cmd.join(" ").includes("command -v git"));
		expect(await bootContainer(unusable as never, "small", snapshot)).toBe("fresh");
		expect(unusable.destroy).toHaveBeenCalledOnce();
		expect(unusable.starts.at(-1)).toMatchObject({ image: IMAGE });
		const running = fakeContainer();
		running.running = true;
		expect(await bootContainer(running as never, "small", snapshot)).toBe("running");
	});

	const gateFor = (own: boolean) => {
		const storage = new FakeStorage();
		const container = fakeContainer();
		const id = { equals: () => own };
		const gate = new Gate({ storage, container, id } as never, { GATE: { idFromName: () => ({}), getByName: () => ({ snapshot: async () => null }) } } as never);
		return { storage, container, gate };
	};
	const warmInput = { repo: "acme--web", branch: "main", base: { remote: "https://git.test/web.git", token: "t" }, checks: ["npm test"] };

	it("is taken by the repo's own Gate after a warm-up on main, from a fresh container", async () => {
		const { storage, container, gate } = gateFor(true);
		await gate.warm(warmInput);
		expect(await storage.get("snapshot")).toMatchObject({ id: "snap-1", size: 123e6 });
		expect(container.snapshots).toBe(1);
	});

	it("is never taken from a container that ran a change's code, nor by another lane", async () => {
		const tainted = gateFor(true);
		await tainted.storage.put("tainted", true);
		tainted.container.running = true;
		await tainted.storage.put("prepared", true);
		await tainted.gate.warm(warmInput);
		expect(tainted.container.snapshots).toBe(0);
		const lane = gateFor(false);
		await lane.gate.warm(warmInput);
		expect(lane.container.snapshots).toBe(0);
	});

	it("isn't started from once it may have expired, and is forgotten only by its id", async () => {
		vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
		try {
			const { storage, gate } = gateFor(true);
			await storage.put("snapshot", snapshot);
			expect(await gate.snapshot()).toEqual(snapshot);
			await gate.forgetSnapshot("other");
			expect(await gate.snapshot()).toEqual(snapshot);
			vi.setSystemTime(1_000 + 25 * 24 * 3600_000);
			expect(await gate.snapshot()).toBeNull();
			await gate.forgetSnapshot();
			expect(await storage.get("snapshot")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
