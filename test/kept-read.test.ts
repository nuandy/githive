import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// Reads that tolerate brief staleness, such as the claims for the claims tool
// and next, are cached in the repo's RepoCache, so many callers at once read the
// repo once.

const { RepoCache } = await import("../src/repo-cache");
const { keptRead } = await import("../src/toolkit/env");

const world = () => {
	const live = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
	// As the runtime does: a Durable Object's storage calls within one call aren't interleaved with another call's.
	let turn: Promise<unknown> = Promise.resolve();
	const serial = new Proxy(live, {
		get: (target, key) => {
			const value = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const run = turn.then(() => value.apply(target, args));
				turn = run.catch(() => undefined);
				return run;
			};
		},
	});
	return { live, env: { REPO_CACHE: { getByName: () => serial } } as never };
};

describe("a kept read", () => {
	it("reads the repo itself when the RepoCache doesn't answer, or can't keep what was read", async () => {
		const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
		const read = vi.fn(async () => ({ claims: ["a"] }));
		const unreachable = {
			REPO_CACHE: { getByName: () => ({ view: down, startBuild: down, keep: down, buildFailed: down }) },
		} as never;
		expect(await keptRead(unreachable, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const cantKeep = {
				REPO_CACHE: {
					getByName: () => ({
						view: async () => ({ json: undefined, fresh: false, building: false, writes: 0 }),
						startBuild: async () => true,
						keep: down,
						buildFailed: down,
					}),
				},
			} as never;
			expect(await keptRead(cantKeep, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		} finally {
			errors.mockRestore();
		}
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("builds once when nothing is kept, then serves the kept copy while it's fresh", async () => {
		const { env } = world();
		const read = vi.fn(async () => ({ claims: ["a"] }));
		expect(await keptRead(env, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		expect(await keptRead(env, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("isn't sent a view again that this isolate already has", async () => {
		const { live, env } = world();
		const sent: (string | undefined)[] = [];
		const view = live.view.bind(live);
		live.view = async (...args) => {
			const answer = await view(...args);
			sent.push(answer.json);
			return answer;
		};
		const read = vi.fn(async () => ({ claims: ["a"] }));
		await keptRead(env, "seen", "claims-advice", 30_000, read);
		expect(await keptRead(env, "seen", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		expect(await keptRead(env, "seen", "claims-advice", 30_000, read)).toEqual({ claims: ["a"] });
		expect(read).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([undefined, undefined, undefined]);
	});

	it("after a write, rebuilds for one caller and serves the others the stale copy meanwhile", async () => {
		const { env, live } = world();
		let version = 1;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const read = vi.fn(async () => {
			const v = version;
			if (v === 2) await gate;
			return { claims: [`v${v}`] };
		});
		await keptRead(env, "p", "claims-advice", 30_000, read);
		version = 2;
		await live.ping("records");
		const rebuilding = keptRead(env, "p", "claims-advice", 30_000, read);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// While the build runs, another caller gets the copy cached before the write at once.
		expect(await keptRead(env, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["v1"] });
		release();
		expect(await rebuilding).toEqual({ claims: ["v2"] });
		expect(await keptRead(env, "p", "claims-advice", 30_000, read)).toEqual({ claims: ["v2"] });
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("reads the repo once for many callers arriving with nothing kept", async () => {
		const { env } = world();
		const read = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { claims: ["a"] };
		});
		const results = await Promise.all(
			Array.from({ length: 20 }, () => keptRead(env, "p", "claims-advice", 30_000, read)),
		);
		expect(results.every((r) => r.claims[0] === "a")).toBe(true);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
