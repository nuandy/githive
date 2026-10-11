import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// The Gate, without real containers. The repo's own Gate warms on main to keep
// the repo's snapshot, a change's Gate runs its checks, and each stops its
// container once nothing needs it.

const { Gate } = await import("../src/gate");

describe("warming the repo's own Gate", () => {
	const input = {
		repo: "express",
		branch: "master",
		base: { remote: "https://git.test/express.git", token: "read" },
		checks: ["npm install", "npm test"],
	};

	it("returns at once and warms in the background when the checks are set up", async () => {
		const storage = new FakeStorage();
		const gate = new Gate({ storage } as never, {} as never);
		await gate.warmUp({ ...input, why: "set up" });
		expect(storage.alarm).not.toBeNull();
		expect(await storage.get("warmUp")).toEqual(input);
		await gate.alarm();
		expect(await storage.get("warmUp")).toBeUndefined();
	});

	it("warms for a merge only while there's no usable snapshot: the merge's own Gate starts from it", async () => {
		const storage = new FakeStorage();
		const gate = new Gate({ storage } as never, {} as never);
		await gate.warmUp({ ...input, why: "checked" });
		expect(await storage.get("warmUp")).toEqual(input);
		await storage.delete("warmUp");
		storage.alarm = null;
		await storage.put("snapshot", { id: "s1", size: 1, at: Date.now() });
		await gate.warmUp({ ...input, why: "approved" });
		expect(storage.alarm).toBeNull();
	});

	it("warms a repo with no checks too (its Gate lands the batches), but not for a merge after a snapshot", async () => {
		const storage = new FakeStorage();
		const gate = new Gate({ storage } as never, {} as never);
		await gate.warmUp({ repo: "express", base: { remote: "r", token: "t" }, checks: [], why: "set up" });
		expect(storage.alarm).not.toBeNull();
		await storage.deleteAlarm();
		await storage.put("snapshot", { id: "s1", size: 1, at: Date.now() });
		await gate.warmUp({ repo: "express", base: { remote: "r", token: "t" }, checks: [], why: "claimed" });
		expect(storage.alarm).toBeNull();
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
		expect(withInstall(["npm install", "npm test"], { packageJson: true, npmLockfile: true })).toEqual([
			"npm install",
			"npm test",
		]);
		expect(
			withInstall(["pnpm install --frozen-lockfile", "pnpm test"], { packageJson: true, npmLockfile: false }),
		).toEqual(["pnpm install --frozen-lockfile", "pnpm test"]);
		expect(withInstall(["cargo test"], { packageJson: false, npmLockfile: false })).toEqual(["cargo test"]);
	});

	it("adds no npm install to a Bun project, whose dependencies come from its own lockfile", async () => {
		const { withInstall } = await import("../src/gate");
		const bun = { packageJson: true, npmLockfile: false, bunLockfile: true };
		expect(withInstall(["bun test"], bun)).toEqual(["bun test"]);
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

	it("stops a grace after its last run, and not before", async () => {
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const { GRACE_MS } = await import("../src/gate");
			const storage = new FakeStorage();
			const container = { running: true, destroy: vi.fn(async () => void (container.running = false)) };
			const gate = new Gate({ storage, container } as never, {} as never);
			await storage.put("lastActive", start);
			await gate.alarm();
			expect(container.destroy).not.toHaveBeenCalled();
			expect(storage.alarm).toBe(start + GRACE_MS);
			vi.setSystemTime(start + GRACE_MS);
			storage.alarm = null;
			await gate.alarm();
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
		exec: async (cmd: string[]) => ({
			output: async () => ({ exitCode: fails(cmd) ? 1 : 0, stdout: new Uint8Array() }),
		}),
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

	it("boots a batch's check container from the snapshot while the batch is read, before its check", async () => {
		const storage = new FakeStorage();
		const container = fakeContainer();
		const gate = new Gate(
			{ storage, container, id: { equals: () => false } } as never,
			{ GATE: { idFromName: () => ({}), getByName: () => ({ snapshot: async () => snapshot }) } } as never,
		);
		await gate.boot({ repo: "acme--web", base: { remote: "https://git.test/web.git", token: "t" } });
		expect(container.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "s1" } })]);
		expect(await storage.get("prepared")).toBe(true);
	});

	it("tries a snapshot once more when Containers is briefly unavailable, before the image", async () => {
		const { bootContainer, IMAGE } = await import("../src/container");
		// The first start's connection is lost; the second restores.
		const flaky = fakeContainer();
		let lost = 1;
		const exec = flaky.exec;
		flaky.exec = async (cmd: string[]) => {
			if (lost-- > 0) throw new Error("The container connection is temporarily unavailable, try again shortly");
			return exec(cmd);
		};
		expect(await bootContainer(flaky as never, "small", snapshot)).toBe("restored");
		expect(flaky.starts).toEqual([
			expect.objectContaining({ containerSnapshot: { id: "s1" } }),
			expect.objectContaining({ containerSnapshot: { id: "s1" } }),
		]);
		// Lost twice, so it falls back to the image.
		const gone = fakeContainer();
		gone.exec = async (cmd: string[]) => {
			if (cmd.join(" ").includes("command -v git"))
				throw new Error("The container connection is temporarily unavailable, try again shortly");
			return exec(cmd);
		};
		expect(await bootContainer(gone as never, "small", snapshot)).toBe("fresh");
		expect(gone.starts.map((s) => (s.image ? "image" : "snapshot"))).toEqual(["snapshot", "snapshot", "image"]);
		expect(gone.starts.at(-1)).toMatchObject({ image: IMAGE });
	});

	it("starts a container in seconds, and an unusable one falls back to the image", async () => {
		const { bootContainer, IMAGE } = await import("../src/container");
		const restored = fakeContainer();
		expect(await bootContainer(restored as never, "small", snapshot)).toBe("restored");
		expect(restored.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "s1" } })]);
		// A container started without its checkout, for example because it expired, is destroyed and started again
		// from the image with git installed.
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
		const gate = new Gate(
			{ storage, container, id } as never,
			{ GATE: { idFromName: () => ({}), getByName: () => ({ snapshot: async () => null }) } } as never,
		);
		return { storage, container, gate };
	};
	const warmInput = {
		repo: "acme--web",
		branch: "main",
		base: { remote: "https://git.test/web.git", token: "t" },
		checks: ["npm test"],
	};

	it("is taken by the repo's own Gate after a warm-up on main, from a fresh container", async () => {
		const { storage, container, gate } = gateFor(true);
		await gate.warm(warmInput);
		expect(await storage.get("snapshot")).toMatchObject({ id: "snap-1", size: 123e6 });
		expect(container.snapshots).toBe(1);
	});

	it("is never taken from a container that ran a change's code, nor by a change's Gate", async () => {
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
