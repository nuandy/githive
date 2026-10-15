import { describe, expect, it } from "vitest";

const { keptView, TOO_OLD_MS } = await import("../src/routes/kept-view");

// A kept view is served at once while it's rebuilt in the background, so a stale one costs a reader nothing. One kept
// too long is built before it's served instead: the first reader after a quiet stretch once saw a History days old.

/**
 * A repo cache keeping `kept`, kept `ageMs` ago. Its build lease is held by the first caller to take it, as RepoCache's
 * is, and `builds` counts the views it was given back.
 */
function keptCache(kept: string, ageMs: number) {
	let leased = false;
	const cache = {
		builds: 0,
		view: async () => ({ json: kept, version: Date.now() - ageMs, fresh: false, building: leased, writes: 0 }),
		startBuild: async () => {
			if (leased) return false;
			leased = true;
			return true;
		},
		keep: async () => {
			cache.builds++;
			leased = false;
			return 1;
		},
		buildFailed: async () => void (leased = false),
	};
	return cache;
}

/** A context for keptView reading from `cache`. */
function viewContext(cache: ReturnType<typeof keptCache>) {
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
		const { c, settled } = viewContext(keptCache('{"total":4}', 5 * 60_000));
		const answer = await keptView(c as never, "repo:acme--web", "history:main", 60_000, build);
		expect(await answer.text()).toBe('{"total":4}');
		expect(answer.headers.get("Server-Timing")).toBe("view;desc=stale");
		await settled();
	});

	it("is built again before it's served once it's older than TOO_OLD_MS", async () => {
		const { c, settled } = viewContext(keptCache('{"total":4}', TOO_OLD_MS + 60_000));
		const answer = await keptView(c as never, "repo:acme--web", "history:main", 60_000, build);
		expect(await answer.text()).toBe('{"total":6}');
		expect(answer.headers.get("Server-Timing")).toMatch(/^view;desc=built/);
		await settled();
	});

	it("is built once when a crowd finds it too old: the others get it as it is meanwhile", async () => {
		const cache = keptCache('{"total":4}', TOO_OLD_MS + 60_000);
		const readers = [1, 2, 3].map(() => viewContext(cache));
		const answers = await Promise.all(
			readers.map(({ c }) => keptView(c as never, "repo:acme--web", "history:main", 60_000, build)),
		);
		const texts = await Promise.all(answers.map((answer) => answer.text()));
		await Promise.all(readers.map(({ settled }) => settled()));
		expect(cache.builds).toBe(1);
		expect(texts.filter((text) => text === '{"total":6}')).toHaveLength(1);
		expect(texts.filter((text) => text === '{"total":4}')).toHaveLength(2);
	});
});
