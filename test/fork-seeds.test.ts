import { describe, expect, it, vi } from "vitest";

// An agent's fork is made from one of its project's seed forks, each made
// from the project once: a crowd of agents arriving together copies the
// project 16 times, not once each.

const artifacts = vi.hoisted(() => ({ made: new Set<string>(), forks: [] as string[] }));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => {
		if (name.startsWith("fork--") && !artifacts.made.has(name)) throw new Error(`Repository not found: ${name}`);
		return { url: `https://git.test/${name}.git`, token: scope };
	}),
	forkAndWait: vi.fn(async (_artifacts: unknown, source: string, name: string) => {
		artifacts.forks.push(`${source} -> ${name}`);
		artifacts.made.add(name);
		return { name, remote: `https://git.test/${name}.git`, token: "write" };
	}),
}));

const { changeRemote, FORK_SEEDS, seedName } = await import("../src/toolkit/env");

describe("agents' forks", () => {
	it("are made from the project's seeds, each seed made once", async () => {
		const env = {} as Env;
		for (let i = 0; i < 100; i++) await changeRemote(env, "seeded", `agent-${i}`, "write", 60);
		const fromProject = artifacts.forks.filter((f) => f.startsWith("seeded -> "));
		expect(fromProject.length).toBeLessThanOrEqual(FORK_SEEDS);
		expect(fromProject.every((f) => /-> fork--seeded--seed--\d+$/.test(f))).toBe(true);
		const agents = artifacts.forks.filter((f) => f.includes("--agent--"));
		expect(agents).toHaveLength(100);
		expect(agents.every((f) => f.startsWith("fork--seeded--seed--"))).toBe(true);
		// Spread over the seeds, not all on one.
		expect(new Set(agents.map((f) => f.split(" -> ")[0])).size).toBeGreaterThan(FORK_SEEDS / 2);
		expect(seedName("seeded", 3)).toBe("fork--seeded--seed--3");
	});

	it("are only read, never made, when asked for to read", async () => {
		await expect(changeRemote({} as Env, "seeded", "agent-none", "read", 60)).rejects.toThrow(/no fork yet/);
	});
});
