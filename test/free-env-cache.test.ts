import { describe, expect, it, vi } from "vitest";

// Minting an Artifacts token is several Artifacts calls, and every tool call
// needs one or more; so tokens are kept per repo and scope while fresh, across
// callers and calls in the isolate. So is each record's log, so a read whose
// ref hasn't moved needn't fetch it again.

const artifacts = vi.hoisted(() => ({ mints: [] as string[] }));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => {
		artifacts.mints.push(`${name}|${scope}`);
		return { url: `https://git.test/${name}.git`, token: `${scope}-${artifacts.mints.length}` };
	}),
}));

const { freeContextFor } = await import("../src/free/env");

describe("the coordinator-free context's caches", () => {
	it("mints a repo's token once per scope, for every caller", async () => {
		const env = {} as Env;
		const [a, b] = [freeContextFor(env, "service:a"), freeContextFor(env, "service:b")];
		const first = await a.remote("cache-p", "read");
		expect(await b.remote("cache-p", "read")).toEqual(first);
		expect(await a.remote("cache-p", "write")).not.toEqual(first);
		expect(artifacts.mints.filter((m) => m.startsWith("cache-p|"))).toEqual(["cache-p|read", "cache-p|write"]);
	});

	it("never hands one call a token another call is still minting: in Workers, a request can't wait on another's I/O", async () => {
		const env = {} as Env;
		await Promise.all([freeContextFor(env, "service:a").remote("cache-s", "read"), freeContextFor(env, "service:b").remote("cache-s", "read")]);
		expect(artifacts.mints.filter((m) => m.startsWith("cache-s|"))).toEqual(["cache-s|read", "cache-s|read"]);
		// Once minted, it is shared.
		await freeContextFor(env, "service:c").remote("cache-s", "read");
		expect(artifacts.mints.filter((m) => m.startsWith("cache-s|"))).toHaveLength(2);
	});

	it("keeps a change fork's token too", async () => {
		const env = {} as Env;
		await freeContextFor(env, "service:a").changeRemote!("cache-q", "c-1", "read");
		await freeContextFor(env, "service:b").changeRemote!("cache-q", "c-1", "read");
		expect(artifacts.mints.filter((m) => m.startsWith("free--cache-q--c-1"))).toEqual(["free--cache-q--c-1|read"]);
	});

	it("shares each record's log across callers", () => {
		const env = {} as Env;
		const ref = "refs/notes/blueprint-claims/cache-r";
		expect(freeContextFor(env, "service:a").records!("cache-r", ref)).toBe(freeContextFor(env, "service:b").records!("cache-r", ref));
	});
});
