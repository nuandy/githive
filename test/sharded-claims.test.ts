import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claimStore } from "../src/toolkit/claim-store";
import { claim, type Registry } from "../src/toolkit/claims";
import { appendRecord } from "../src/toolkit/records";
import { changeRef, recordsRepoOf, shardsPrefix } from "../src/toolkit/shards";
import { entriesOverlap } from "../src/claim-paths";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Sharded claims on a real Git server: each shard is its own ref, so claims in
// different parts of the tree never contend. Overlaps within a shard are
// settled by the ref's compare-and-swap; across levels (a wide claim and the
// deeper claims it covers), each claim checks the other level after writing
// itself, and backs out if it finds an overlap.

let server: GitServer;
const remote = async () => ({ url: server.url, token: "unused" });
const root = () => new GitCasLog<Registry>(remote, "p", "refs/notes/githive-claims/p");
const store = () =>
	claimStore({ repo: "p", registry: { claims: [], released: [], shardDepth: 2 }, root: root(), remote });
const shardRefs = () =>
	server.git("for-each-ref", "--format=%(refname)", shardsPrefix("p")).trim().split("\n").filter(Boolean);
const want = (change: string, paths: string[], now?: number) => ({
	change,
	agent: `agent-${change}`,
	paths,
	intent: change,
	...(now ? { now } : {}),
	staleAfterMs: 30 * 60_000,
});
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
		expect(await active()).toEqual([
			["a-1", ["src/a/"]],
			["b-1", ["src/b/x.ts"]],
		]);
	});

	it("refuses an overlapping claim in the same shard, naming the holder", async () => {
		await store().claim(want("a-1", ["src/a/"]));
		expect(await store().claim(want("b-1", ["src/a/x.ts"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1", path: "src/a/x.ts" }],
		});
	});

	it("refuses a deep claim under a wide one, and a wide claim over a deep one", async () => {
		await store().claim(want("wide-1", ["src/"]));
		expect(await store().claim(want("deep-1", ["src/a/x.ts"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "wide-1" }],
		});
		expect(await store().claim(want("docs-1", ["docs/guide/a.md"]))).toMatchObject({ ok: true });
		expect(await store().claim(want("docs-2", ["docs/"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "docs-1" }],
		});
		// Backing out left nothing behind.
		expect(await active()).toEqual([
			["docs-1", ["docs/guide/a.md"]],
			["wide-1", ["src/"]],
		]);
	});

	it("never lets a wide claim and a deep claim it covers both stand, even made at once", async () => {
		for (let round = 0; round < 3; round++) {
			const outcomes = await Promise.all([
				store().claim(want(`wide-${round}`, [`r${round}/`])),
				store().claim(want(`deep-${round}`, [`r${round}/a/x.ts`])),
			]);
			expect(outcomes.filter((o) => o.ok).length).toBeLessThanOrEqual(1);
		}
		const held = (await store().read()).claims;
		for (const a of held)
			for (const b of held)
				if (a !== b)
					for (const p of a.paths)
						for (const q of b.paths) expect(entriesOverlap(p, q), `${a.change} and ${b.change}`).toBe(false);
	});

	it("backs a claim spanning shards out of every shard when one part is refused", async () => {
		await store().claim(want("b-1", ["src/b/"]));
		expect(await store().claim(want("a-1", ["src/a/", "src/b/x.ts"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "b-1" }],
		});
		expect(await active()).toEqual([["b-1", ["src/b/"]]]);
	});

	it("backs a refused extension out to what the change held before", async () => {
		await store().claim(want("a-1", ["src/a/"]));
		await store().claim(want("d-1", ["docs/x/y.md"]));
		expect(await store().claim(want("a-1", ["src/a/more/", "docs/"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "d-1" }],
		});
		expect(await active()).toEqual([
			["a-1", ["src/a/"]],
			["d-1", ["docs/x/y.md"]],
		]);
	});

	it("reads a change's claim across shards as one, and releases it from all of them", async () => {
		await store().claim(want("a-1", ["src/a/", "docs/a.md"]));
		expect(await active()).toEqual([["a-1", ["docs/a.md", "src/a/"]]]);
		expect(await store().release({ change: "a-1", agent: "agent-a-1", reason: "done", mergedAs: "m1" })).toMatchObject({
			ok: true,
		});
		const view = await store().read();
		expect(view.claims).toEqual([]);
		expect(view.released.filter((r) => r.change === "a-1").map((r) => r.mergedAs)).toEqual(["m1", "m1"]);
	});

	it("takes paths a stale claim at another level holds, releasing it", async () => {
		await store().claim(want("old-1", ["src/"], Date.now() - 31 * 60_000));
		expect(await store().claim(want("a-1", ["src/a/x.ts"]))).toMatchObject({ ok: true });
		expect(await active()).toEqual([["a-1", ["src/a/x.ts"]]]);
	});

	it("keeps a claim whose record in one shard is idle while the change was claimed again in another", async () => {
		const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
		await store().claim(want("x-1", ["a/x/f.ts"], minutesAgo(31)));
		await store().claim(want("x-1", ["b/y/g.ts"], minutesAgo(6)));
		// In the same shard, and from another level.
		expect(await store().claim({ ...want("y-1", ["a/x/f.ts"]), agent: "agent-y" })).toMatchObject({ ok: false });
		expect(await store().claim({ ...want("z-1", ["a/"]), agent: "agent-z" })).toMatchObject({ ok: false });
		expect(await active()).toEqual([["x-1", ["a/x/f.ts", "b/y/g.ts"]]]);
	});

	it("lets the claims, not a change's index, say whose the change is", async () => {
		// Two agents claiming one name at once: the index names the one whose claim then lost.
		type Index = { shards: string[]; agent?: string; at?: string };
		const index = new GitCasLog<Index>(remote, "p", changeRef("p", "x-1"));
		const nameIn = (agent: string, at: number) =>
			appendRecord(
				index,
				agent,
				() => ({ shards: [] }),
				(state) => ({
					state: { shards: [...state.shards, "a/x"], agent, at: new Date(at).toISOString() },
					text: `${agent} names x-1`,
				}),
			);
		await store().claim(want("x-1", ["a/x/f.ts"]));
		await nameIn("agent-other", Date.now());
		// Its holder still extends it, and anyone else is told it's that holder's.
		expect(await store().claim(want("x-1", ["b/y/g.ts"]))).toMatchObject({ ok: true });
		await expect(store().claim({ ...want("x-1", ["c/z/h.ts"]), agent: "agent-c" })).rejects.toThrow(/agent-x-1/);
		expect(await active()).toEqual([["x-1", ["a/x/f.ts", "b/y/g.ts"]]]);
	});

	it("holds a name its index just gave another agent, whose claim is on its way, and frees it after", async () => {
		type Index = { shards: string[]; agent?: string; at?: string };
		const index = new GitCasLog<Index>(remote, "p", changeRef("p", "y-1"));
		const nameIn = (agent: string, at: number) =>
			appendRecord(
				index,
				agent,
				() => ({ shards: [] }),
				(state) => ({
					state: { shards: [...state.shards, "a/x"], agent, at: new Date(at).toISOString() },
					text: `${agent} names y-1`,
				}),
			);
		await nameIn("agent-first", Date.now());
		await expect(store().claim(want("y-1", ["a/x/f.ts"]))).rejects.toThrow(/agent-first/);
		// An index left by a claim that never got written frees the name after a while.
		await nameIn("agent-first", Date.now() - 3 * 60_000);
		expect(await store().claim(want("y-1", ["a/x/f.ts"]))).toMatchObject({ ok: true });
	});

	it("frees a claim idle in every shard from all of them at once", async () => {
		await store().claim(want("x-1", ["a/x/f.ts", "b/y/g.ts"], Date.now() - 31 * 60_000));
		expect(await store().claim({ ...want("z-1", ["a/"]), agent: "agent-z" })).toMatchObject({ ok: true });
		expect(await active()).toEqual([["z-1", ["a/"]]]);
	});

	it("forgets the landing attempts of a stale claim a new one takes over, sharded or not", async () => {
		const forgotten: string[] = [];
		const forgetAttempts = async (change: string) => void forgotten.push(change);
		const plain = () =>
			claimStore({ repo: "p", registry: { claims: [], released: [] }, root: root(), remote, forgetAttempts });
		await plain().claim(want("old-1", ["src/"], Date.now() - 31 * 60_000));
		const takeover = { ...want("old-1", ["src/"]), agent: "agent-new" };
		expect(await plain().claim(takeover)).toMatchObject({ ok: true });
		expect(forgotten).toEqual(["old-1"]);
	});

	it("cites, for a merge, the tips of the shards its files and claim are in, and their ancestors", async () => {
		await store().claim(want("wide-1", ["docs/"]));
		await store().claim(want("a-1", ["src/a/"]));
		const view = await store().read();
		const own = view.claims.find((c) => c.change === "a-1")!;
		expect(store().cite(view, ["src/a/x.ts"], own)).toBe(`src%2Fa=${view.tips.get("src/a")}`);
		expect(store().cite(view, ["docs/x/y.md"], own)).toBe(
			`docs=${view.tips.get("docs")} src%2Fa=${view.tips.get("src/a")}`,
		);
	});

	it("reads every shard in one listing and one fetch, however many there are", async () => {
		for (const i of [1, 2, 3, 4, 5]) await store().claim(want(`c-${i}`, [`area${i}/x/`]));
		// Claiming read each shard as it checked, so a reader that hasn't seen them is a fresh copy of the store.
		vi.resetModules();
		const { claimStore: freshStore } = await import("../src/toolkit/claim-store");
		const reader = freshStore({
			repo: "p",
			registry: { claims: [], released: [], shardDepth: 2 },
			root: root(),
			remote,
		});
		const before = server.requests.length;
		expect((await reader.read()).claims).toHaveLength(5);
		// The shards' listing and fetch, and the registry's listing (it has nothing to fetch here).
		expect(server.requests.slice(before).sort()).toEqual([
			"GET refs?service=git-upload-pack",
			"GET refs?service=git-upload-pack",
			"POST git-upload-pack",
		]);
		// Nothing changed since: the listings alone, the states already known.
		const again = server.requests.length;
		expect((await reader.read()).claims).toHaveLength(5);
		expect(server.requests.slice(again)).toEqual([
			"GET refs?service=git-upload-pack",
			"GET refs?service=git-upload-pack",
		]);
	});

	it("retries a read the server fails for a moment", async () => {
		await store().claim(want("e-1", ["fresh/one/"]));
		server.failFetches(1);
		expect((await store().read()).claims.map((c) => c.change)).toContain("e-1");
	});
});

describe("sharded claims across records repos", { timeout: 60_000 }, () => {
	// Artifacts takes one push at a time per repo, so with many agents the shards are spread over several small
	// records repos by a hash of each shard. Pushes to different records repos run side by side.
	const records = (k: number) => server.repo(`rec-${k}`);
	const spread = () =>
		claimStore({
			repo: "p",
			registry: { claims: [], released: [], shardDepth: 2, recordsRepos: 4 },
			root: root(),
			remote,
			recordsRemote: async (k) => ({ url: records(k), token: "unused" }),
		});
	const refsIn = (k: number) => (
		records(k),
		server
			.gitIn(`rec-${k}`, "for-each-ref", "--format=%(refname)", shardsPrefix("p"))
			.trim()
			.split("\n")
			.filter(Boolean)
	);

	it("spreads the shards over the records repos, by hash, and reads them as one", async () => {
		const areas = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
		for (const [i, area] of areas.entries())
			expect(await spread().claim(want(`c-${i}`, [`${area}/x/`]))).toMatchObject({ ok: true });
		for (const area of areas)
			expect(refsIn(recordsRepoOf(`${area}/x`, 4))).toContain(`${shardsPrefix("p")}${area}%2Fx`);
		expect(new Set(areas.map((a) => recordsRepoOf(`${a}/x`, 4))).size).toBeGreaterThan(1);
		expect(shardRefs()).toEqual([]);
		expect((await spread().read()).claims.map((c) => c.change)).toEqual(areas.map((_, i) => `c-${i}`));
	});

	it("still refuses across levels when the two shards are in different records repos", async () => {
		// A wide claim and a deep one under it whose shards hash to different repos.
		const area = ["a", "b", "c", "d", "e", "f", "g", "h"].find(
			(x) => recordsRepoOf(x, 4) !== recordsRepoOf(`${x}/y`, 4),
		)!;
		await spread().claim(want("wide-1", [`${area}/`]));
		expect(await spread().claim(want("deep-1", [`${area}/y/z.ts`]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "wide-1" }],
		});
		await spread().release({ change: "wide-1", agent: "agent-wide-1", reason: "done" });
		await spread().claim(want("deep-2", [`${area}/y/z.ts`]));
		expect(await spread().claim(want("wide-2", [`${area}/`]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "deep-2" }],
		});
	});

	it("reads one change from its index and its own shards: two repos at most, not all of them", async () => {
		const areas = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
		for (const [i, area] of areas.entries()) await spread().claim(want(`c-${i}`, [`${area}/x/`]));
		const before = server.requestsTo.length;
		const { claim } = await spread().readChange("c-3");
		expect(claim?.paths).toEqual(["delta/x/"]);
		expect(new Set(server.requestsTo.slice(before).map((r) => r.split(" ")[0])).size).toBeLessThanOrEqual(2);

		const releasing = server.requestsTo.length;
		expect(await spread().release({ change: "c-3", agent: "agent-c-3", reason: "done" })).toEqual({ ok: true });
		expect(new Set(server.requestsTo.slice(releasing).map((r) => r.split(" ")[0])).size).toBeLessThanOrEqual(2);
		expect((await spread().readChange("c-3")).claim).toBeUndefined();
	});

	it("still finds a change whose claim has no index, by reading everything", async () => {
		// Claimed straight into its shard, as before changes were indexed.
		const shard = new GitCasLog<Registry>(
			async () => ({ url: records(recordsRepoOf("old/x", 4)), token: "unused" }),
			"p",
			`${shardsPrefix("p")}old%2Fx`,
		);
		await claim(shard, want("old-1", ["old/x/"]));
		expect((await spread().readChange("old-1")).claim?.paths).toEqual(["old/x/"]);
	});
});
