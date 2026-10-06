import { describe, expect, it } from "vitest";
import { FakeStorage } from "./fakes/env";

const { TokenCache } = await import("../src/token-cache");

// Artifacts tokens kept past an isolate: reused until their reuse window ends, then gone.

describe("the token cache", () => {
	it("returns a kept token until its window ends, then forgets it", async () => {
		const storage = new FakeStorage();
		const cache = new TokenCache({ storage } as never, {} as never);
		const remote = { url: "https://example/r.git", token: "t" };
		expect(await cache.get("r|read")).toBeNull();
		await cache.put("r|read", remote, Date.now() + 60_000);
		expect(await cache.get("r|read")).toMatchObject({ remote });
		await cache.put("r|write", remote, Date.now() - 1);
		expect(await cache.get("r|write")).toBeNull();
		expect(storage.data.has("r|write")).toBe(false);
	});
});
