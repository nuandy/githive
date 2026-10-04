import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { claimStore } from "../src/free/claim-store";
import type { Registry } from "../src/free/claims";
import { shardsPrefix } from "../src/free/shards";
import { entriesOverlap } from "../src/open-mode";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Sharded claims on a real Git server: each shard is its own ref, so claims in
// different parts of the tree never contend. Overlaps within a shard are
// settled by the ref's compare-and-swap; across levels (a wide claim and the
// deeper claims it covers), each claim checks the other level after writing
// itself, and backs out if it finds an overlap.

let server: GitServer;
const remote = async () => ({ url: server.url, token: "unused" });
const root = () => new GitCasLog<Registry>(remote, "p", "refs/notes/blueprint-claims/p");
const store = () => claimStore({ repo: "p", registry: { claims: [], released: [], shardDepth: 2 }, root: root(), remote });
const shardRefs = () => server.git("for-each-ref", "--format=%(refname)", shardsPrefix("p")).trim().split("\n").filter(Boolean);
const want = (change: string, paths: string[], now?: number) => ({ change, agent: `agent-${change}`, paths, intent: change, ...(now ? { now } : {}), staleAfterMs: 30 * 60_000 });
const active = async () => (await store().read()).claims.map((c) => [c.change, c.paths]);

beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

describe("sharded claims", { timeout: 60_000 }, () => {
	it("writes claims in different parts of the tree to different refs", async () => {
		expect(await store().claim(want("a-1", ["src/a/"]))).toMatchObject({ ok: true });
		expect(await store().claim(want("b-1", ["src/b/x.ts"]))).toMatchObject({ ok: true });
		expect(shardRefs().map((r) => r.slice(shardsPrefix("p").length))).toEqual(["src%2Fa", "src%2Fb"]);
		expect(await active()).toEqual([["a-1", ["src/a/"]], ["b-1", ["src/b/x.ts"]]]);
	});

	it("refuses an overlapping claim in the same shard, naming the holder", async () => {
		await store().claim(want("a-1", ["src/a/"]));
		expect(await store().claim(want("b-1", ["src/a/x.ts"]))).toMatchObject({ ok: false, conflicts: [{ change: "a-1", path: "src/a/x.ts" }] });
	});

	it("refuses a deep claim under a wide one, and a wide claim over a deep one", async () => {
		await store().claim(want("wide-1", ["src/"]));
		expect(await store().claim(want("deep-1", ["src/a/x.ts"]))).toMatchObject({ ok: false, conflicts: [{ change: "wide-1" }] });
		expect(await store().claim(want("docs-1", ["docs/guide/a.md"]))).toMatchObject({ ok: true });
		expect(await store().claim(want("docs-2", ["docs/"]))).toMatchObject({ ok: false, conflicts: [{ change: "docs-1" }] });
		// Backing out left nothing behind.
		expect(await active()).toEqual([["docs-1", ["docs/guide/a.md"]], ["wide-1", ["src/"]]]);
	});

	it("never lets a wide claim and a deep claim it covers both stand, even made at once", async () => {
		for (let round = 0; round < 3; round++) {
			const outcomes = await Promise.all([store().claim(want(`wide-${round}`, [`r${round}/`])), store().claim(want(`deep-${round}`, [`r${round}/a/x.ts`]))]);
			expect(outcomes.filter((o) => o.ok).length).toBeLessThanOrEqual(1);
		}
		const held = (await store().read()).claims;
		for (const a of held) for (const b of held) if (a !== b) for (const p of a.paths) for (const q of b.paths) expect(entriesOverlap(p, q), `${a.change} and ${b.change}`).toBe(false);
	});

	it("backs a claim spanning shards out of every shard when one part is refused", async () => {
		await store().claim(want("b-1", ["src/b/"]));
		expect(await store().claim(want("a-1", ["src/a/", "src/b/x.ts"]))).toMatchObject({ ok: false, conflicts: [{ change: "b-1" }] });
		expect(await active()).toEqual([["b-1", ["src/b/"]]]);
	});

	it("backs a refused extension out to what the change held before", async () => {
		await store().claim(want("a-1", ["src/a/"]));
		await store().claim(want("d-1", ["docs/x/y.md"]));
		expect(await store().claim(want("a-1", ["src/a/more/", "docs/"]))).toMatchObject({ ok: false, conflicts: [{ change: "d-1" }] });
		expect(await active()).toEqual([["a-1", ["src/a/"]], ["d-1", ["docs/x/y.md"]]]);
	});

	it("reads a change's claim across shards as one, and releases it from all of them", async () => {
		await store().claim(want("a-1", ["src/a/", "docs/a.md"]));
		expect(await active()).toEqual([["a-1", ["docs/a.md", "src/a/"]]]);
		expect(await store().release({ change: "a-1", agent: "agent-a-1", reason: "done", mergedAs: "m1" })).toMatchObject({ ok: true });
		const view = await store().read();
		expect(view.claims).toEqual([]);
		expect(view.released.filter((r) => r.change === "a-1").map((r) => r.mergedAs)).toEqual(["m1", "m1"]);
	});

	it("takes paths a stale claim at another level holds, releasing it", async () => {
		await store().claim(want("old-1", ["src/"], Date.now() - 31 * 60_000));
		expect(await store().claim(want("a-1", ["src/a/x.ts"]))).toMatchObject({ ok: true });
		expect(await active()).toEqual([["a-1", ["src/a/x.ts"]]]);
	});

	it("cites, for a merge, the tips of the shards its files and claim are in, and their ancestors", async () => {
		await store().claim(want("wide-1", ["docs/"]));
		await store().claim(want("a-1", ["src/a/"]));
		const view = await store().read();
		const own = view.claims.find((c) => c.change === "a-1")!;
		expect(store().cite(view, ["src/a/x.ts"], own)).toBe(`src%2Fa=${view.tips.get("src/a")}`);
		expect(store().cite(view, ["docs/x/y.md"], own)).toBe(`docs=${view.tips.get("docs")} src%2Fa=${view.tips.get("src/a")}`);
	});
});
