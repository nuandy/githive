import { describe, expect, it, vi } from "vitest";

// Minting an Artifacts token takes several Artifacts calls, and every tool call
// needs at least one. So tokens are cached per repo and scope while fresh,
// across callers and calls in the isolate. Each record's log is cached too, so a
// read whose ref hasn't moved doesn't fetch it again.

const artifacts = vi.hoisted(() => ({ mints: [] as string[] }));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => {
		artifacts.mints.push(`${name}|${scope}`);
		return { url: `https://git.test/${name}.git`, token: `${scope}-${artifacts.mints.length}` };
	}),
}));

const { toolContextFor, forkName } = await import("../src/toolkit/env");

describe("the context's caches", () => {
	it("mints a repo's token once per scope, for every caller", async () => {
		const env = {} as Env;
		const [a, b] = [toolContextFor(env, "service:a"), toolContextFor(env, "service:b")];
		const first = await a.remote("cache-p", "read");
		expect(await b.remote("cache-p", "read")).toEqual(first);
		expect(await a.remote("cache-p", "write")).not.toEqual(first);
		expect(artifacts.mints.filter((m) => m.startsWith("cache-p|"))).toEqual(["cache-p|read", "cache-p|write"]);
	});

	it("never hands one call a token another call is still minting: in Workers, a request can't wait on another's I/O", async () => {
		const env = {} as Env;
		await Promise.all([
			toolContextFor(env, "service:a").remote("cache-s", "read"),
			toolContextFor(env, "service:b").remote("cache-s", "read"),
		]);
		expect(artifacts.mints.filter((m) => m.startsWith("cache-s|"))).toEqual(["cache-s|read", "cache-s|read"]);
		// Once minted, it is shared.
		await toolContextFor(env, "service:c").remote("cache-s", "read");
		expect(artifacts.mints.filter((m) => m.startsWith("cache-s|"))).toHaveLength(2);
	});

	it("keeps an agent fork's token too", async () => {
		const env = {} as Env;
		await toolContextFor(env, "service:a").changeRemote!("cache-q", "agent-a", "read");
		await toolContextFor(env, "service:b").changeRemote!("cache-q", "agent-a", "read");
		expect(artifacts.mints.filter((m) => m.startsWith("fork--cache-q--agent--agent-a"))).toEqual([
			"fork--cache-q--agent--agent-a|read",
		]);
	});

	it("names one fork per agent, telling apart names that look alike", async () => {
		expect(await forkName("express", "agent-a")).toBe("fork--express--agent--agent-a");
		const [upper, dotted] = [await forkName("express", "Agent.A"), await forkName("express", "agent_a")];
		expect(upper).toMatch(/^fork--express--agent--agent-a-[0-9a-f]{6}$/);
		expect(dotted).toMatch(/^fork--express--agent--agent-a-[0-9a-f]{6}$/);
		expect(upper).not.toBe(dotted);
	});

	it("shares each record's log across callers", () => {
		const env = {} as Env;
		const ref = "refs/notes/githive-claims/cache-r";
		expect(toolContextFor(env, "service:a").records!("cache-r", ref)).toBe(
			toolContextFor(env, "service:b").records!("cache-r", ref),
		);
	});
});
