import { describe, expect, it } from "vitest";

const { keptView, TOO_OLD_MS } = await import("../src/routes/kept-view");

// A kept view is served at once while it's rebuilt in the background, so a stale one costs a reader nothing. One kept
// too long is built before it's served instead: the first reader after a quiet stretch once saw a History days old.

/** A context for keptView whose repo cache keeps `kept`, kept `ageMs` ago, and counts the builds it's asked for. */
function viewContext(kept: string, ageMs: number) {
	const cache = {
		view: async () => ({ json: kept, version: Date.now() - ageMs, fresh: false, building: false, writes: 0 }),
		startBuild: async () => true,
		keep: async () => 1,
		buildFailed: async () => undefined,
	};
	const waiting: Promise<unknown>[] = [];
	const c = {
		env: { REPO_CACHE: { getByName: () => cache } },
		req: { url: "https://githive.test/repos/acme/web/history", header: () => undefined, query: () => undefined },
		executionCtx: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
		body: (json: string, status: number, headers: Record<string, string>) => new Response(json, { status, headers }),
	};
	return { c, settled: () => Promise.all(waiting) };
}

const build = async () => ({ total: 6 });

describe("a kept view", () => {
	it("is served while it's rebuilt when it's merely stale", async () => {
		const { c, settled } = viewContext('{"total":4}', 5 * 60_000);
		const answer = await keptView(c as never, "repo:acme--web", "history:main", 60_000, build);
		expect(await answer.text()).toBe('{"total":4}');
		expect(answer.headers.get("Server-Timing")).toBe("view;desc=stale");
		await settled();
	});

	it("is built again before it's served once it's older than TOO_OLD_MS", async () => {
		const { c, settled } = viewContext('{"total":4}', TOO_OLD_MS + 60_000);
		const answer = await keptView(c as never, "repo:acme--web", "history:main", 60_000, build);
		expect(await answer.text()).toBe('{"total":6}');
		expect(answer.headers.get("Server-Timing")).toMatch(/^view;desc=built/);
		await settled();
	});
});
