import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// Agents' forks are made from a project's seed forks, which are made one at a
// time in the background when GitHive starts on it: a crowd of agents arriving
// at once then forks from several seeds, not all from the project's repo.

const artifacts = vi.hoisted(() => ({ made: new Set<string>(), forks: [] as string[], failing: new Set<string>() }));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => {
		if (name.startsWith("fork--") && !artifacts.made.has(name)) throw new Error(`Repository not found: ${name}`);
		return { url: `https://git.test/${name}.git`, token: scope };
	}),
	forkAndWait: vi.fn(async (_artifacts: unknown, source: string, name: string) => {
		artifacts.forks.push(`${source} -> ${name}`);
		if (artifacts.failing.has(source)) throw new Error(`fork ${name} not ready after 60s`);
		artifacts.made.add(name);
		return { name, remote: `https://git.test/${name}.git`, token: "write" };
	}),
}));

const { changeRemote, FORK_SEEDS, seedItems, seedName } = await import("../src/toolkit/env");
const { LiveFeed } = await import("../src/live-feed");

/** An env whose repo has a fork queue (a real LiveFeed on fake storage) with these seeds ready. */
function envWith(ready: number[]) {
	const storage = new FakeStorage();
	void storage.put("forks:seeds", ready);
	const live = new LiveFeed({ storage, getWebSockets: () => [] } as never, {} as never);
	const env = { LIVE: { getByName: () => live } } as unknown as Env;
	// The queue's own forks go through this env too.
	(live as unknown as { env: Env }).env = env;
	return { env, live, storage };
}

beforeEach(() => {
	artifacts.made.clear();
	artifacts.forks.length = 0;
	artifacts.failing.clear();
});

describe("an agent's fork", () => {
	it("comes from the project while no seed is made yet, and asks for the seeds", async () => {
		const { env, storage } = envWith([]);
		await changeRemote(env, "p", "agent-a", "write", 60);
		expect(artifacts.forks).toEqual(["p -> fork--p--agent--agent-a"]);
		expect(((await storage.get<{ item: string }[]>("forks:queue")) ?? []).map((j) => j.item)).toEqual(seedItems());
	});

	it("comes from its own seed when that's made, else the nearest made one, and passes over one that fails", async () => {
		const { env } = envWith([0, 3]);
		for (let i = 0; i < 20; i++) await changeRemote(env, "p", `agent-${i}`, "write", 60);
		const sources = new Set(artifacts.forks.map((f) => f.split(" -> ")[0]));
		expect([...sources].sort()).toEqual([seedName("p", 0), seedName("p", 3)]);
		artifacts.failing.add(seedName("p", 0));
		artifacts.failing.add(seedName("p", 3));
		artifacts.forks.length = 0;
		await changeRemote(env, "p", "agent-late", "write", 60);
		expect(artifacts.forks.at(-1)).toBe("p -> fork--p--agent--agent-late");
	});

	it("is only read, never made, when asked for to read", async () => {
		await expect(changeRemote(envWith([]).env, "p", "agent-none", "read", 60)).rejects.toThrow(/no fork yet/);
	});
});

describe("the fork queue", () => {
	it("makes the seeds one at a time, then agents' forks a few at a time", async () => {
		const { live, storage } = envWith([]);
		await live.queueForks("p", [...seedItems(), ...["a", "b", "c", "d", "e"].map((x) => `agent:${x}`)]);
		for (let k = 0; k < FORK_SEEDS; k++) {
			await live.alarm();
			expect(await live.readySeeds()).toHaveLength(k + 1);
		}
		expect(artifacts.forks.filter((f) => f.includes("--agent--"))).toEqual([]);
		await live.alarm();
		expect(artifacts.forks.filter((f) => f.includes("--agent--"))).toHaveLength(4);
		await live.alarm();
		expect(artifacts.forks.filter((f) => f.includes("--agent--"))).toHaveLength(5);
		expect(await storage.get("forks:queue")).toEqual([]);
		// Queuing what's made already does nothing.
		await live.queueForks("p", seedItems());
		expect(await storage.get("forks:queue")).toEqual([]);
	});

	it("tries a fork that fails again, then gives up on it (the agent still makes its own)", async () => {
		const { live, storage } = envWith([]);
		artifacts.failing.add("p");
		await live.queueForks("p", ["seed:0"]);
		for (let i = 0; i < 3; i++) await live.alarm();
		expect(artifacts.forks).toHaveLength(3);
		expect(await storage.get("forks:queue")).toEqual([]);
		expect(await live.readySeeds()).toEqual([]);
	});
});
