import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claimStore } from "../src/toolkit/claim-store";
import { type Registry, SHARD_WHEN, shardClaims, shardingReason } from "../src/toolkit/claims";
import { changeRef, shardsPrefix } from "../src/toolkit/shards";
import { entriesOverlap } from "../src/claim-paths";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { shardingToolCalls } from "./helpers/tool-calls";

// Claims start in one record, the registry, and are sharded when the load
// calls for it. Once sharded, the registry is the shard above every other:
// the claims made before stay in it, every shard claim checks it, and a claim
// that lands in it after the switch checks every shard. A claim spread over
// many shards is written once, in the shard holding all its paths.

let server: GitServer;
let work: string;
const remote = async () => ({ url: server.url, token: "unused" });
const rootRef = "refs/notes/githive-claims/p";
const root = () => new GitCasLog<Registry>(remote, "p", rootRef);
const registry = async () => (await root().read())?.commit.state;
/** A store as a caller makes one: from the registry it just read (or `as`, a stale one). */
const store = async (as?: Registry) =>
	claimStore({ repo: "p", registry: as ?? (await registry()), root: root(), remote });
const want = (change: string, paths: string[], now?: number) => ({
	change,
	agent: `agent-${change}`,
	paths,
	intent: change,
	...(now ? { now } : {}),
	staleAfterMs: 30 * 60_000,
});
const refs = (prefix: string) =>
	server.git("for-each-ref", "--format=%(refname)", prefix).trim().split("\n").filter(Boolean);
const shardRefs = () => refs(shardsPrefix("p")).map((r) => r.slice(shardsPrefix("p").length));
const active = async () => (await (await store()).read()).claims.map((c) => [c.change, c.paths]);
const shard = () => shardClaims(root(), { depth: 2, recordsRepos: 0, reason: "test" });

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-on-demand-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("when to shard", () => {
	const at = Date.parse("2026-10-07T12:00:00.000Z");
	const held = (n: number, active = at) =>
		Array.from({ length: n }, (_, i) => ({
			change: `c-${i}`,
			agent: `agent-${i}`,
			paths: [`a${i}/`],
			intent: "x",
			since: new Date(active).toISOString(),
			active: new Date(active).toISOString(),
		}));
	const onDemand = (claims: Registry["claims"], released: Registry["released"] = []): Registry => ({
		claims,
		released,
		autoShard: { depth: 2, recordsRepos: 8 },
	});

	it("shards once as many agents hold claims as one record serves well", () => {
		expect(shardingReason(onDemand(held(SHARD_WHEN.agents - 2)), "newcomer", at)).toBeNull();
		expect(shardingReason(onDemand(held(SHARD_WHEN.agents - 1)), "newcomer", at)).toBe(
			`${SHARD_WHEN.agents} agents hold claims`,
		);
		// An agent already holding a claim isn't counted twice.
		expect(shardingReason(onDemand(held(SHARD_WHEN.agents - 1)), "agent-0", at)).toBeNull();
	});

	it("shards when claims are written faster than one record serves well", () => {
		const releases = (n: number, when: number) =>
			Array.from({ length: n }, (_, i) => ({
				change: `r-${i}`,
				agent: "a",
				by: "a",
				at: new Date(when).toISOString(),
				reason: "done",
				lastActive: new Date(when).toISOString(),
			}));
		const window = SHARD_WHEN.windowMs / 60_000;
		expect(
			shardingReason(onDemand(held(2), releases(SHARD_WHEN.writesPerMinute * window - 2, at)), "agent-0", at),
		).toBeNull();
		expect(shardingReason(onDemand(held(2), releases(SHARD_WHEN.writesPerMinute * window, at)), "agent-0", at)).toMatch(
			/claim writes a minute/,
		);
		// Writes before the window don't count.
		expect(
			shardingReason(
				onDemand(held(2, at - SHARD_WHEN.windowMs - 1), releases(100, at - SHARD_WHEN.windowMs - 1)),
				"agent-0",
				at,
			),
		).toBeNull();
	});

	it("never shards a registry that is sharded, or not sharded on demand", () => {
		expect(shardingReason({ ...onDemand(held(20)), shardDepth: 2 }, "x", at)).toBeNull();
		expect(shardingReason({ claims: held(20), released: [] }, "x", at)).toBeNull();
	});
});

describe("claims before and after sharding", { timeout: 60_000 }, () => {
	it("keeps every claim in the registry until sharded: no shards, no indexes", async () => {
		expect(await (await store()).claim(want("a-1", ["src/a/"]))).toMatchObject({ ok: true });
		expect(await (await store()).claim(want("b-1", ["src/a/x.ts"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1" }],
		});
		expect(refs("refs/notes/")).toEqual([rootRef]);
		expect(await active()).toEqual([["a-1", ["src/a/"]]]);
	});

	it("shards once, keeping the claims made before in the registry, above every shard", async () => {
		await (await store()).claim(want("a-1", ["src/a/"]));
		expect(await shard()).toMatchObject({ ok: true });
		expect(await shard()).toMatchObject({ ok: false, refused: "sharded" });
		// A claim under the registry's is refused; one elsewhere goes to its shard.
		expect(await (await store()).claim(want("b-1", ["src/a/x.ts"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "a-1" }],
		});
		expect(await (await store()).claim(want("c-1", ["src/c/"]))).toMatchObject({ ok: true });
		expect(shardRefs()).toEqual(["src%2Fa", "src%2Fc"]);
		expect(await active()).toEqual([
			["a-1", ["src/a/"]],
			["c-1", ["src/c/"]],
		]);
		// Backing b-1 out left its shard empty.
		expect((await (await store()).readChange("b-1")).claim).toBeUndefined();
		// The claim from before sharding: read and released from the registry alone (it has no index).
		expect(refs(changeRef("p", "a-1"))).toEqual([]);
		expect((await (await store()).readChange("a-1")).claim?.paths).toEqual(["src/a/"]);
		expect(await (await store()).release({ change: "a-1", agent: "agent-a-1", reason: "done" })).toEqual({ ok: true });
		expect(await active()).toEqual([["c-1", ["src/c/"]]]);
	});

	it("makes a claim that lands in the registry after sharding check every shard", async () => {
		const before = await registry();
		await shard();
		await (await store()).claim(want("d-1", ["docs/x/y.md"]));
		// Made from the registry as it was before sharding: written in the registry, it must look below.
		expect(await (await store(before)).claim(want("w-1", ["docs/"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "d-1" }],
		});
		expect(await active()).toEqual([["d-1", ["docs/x/y.md"]]]);
		expect(await (await store(before)).claim(want("e-1", ["etc/"]))).toMatchObject({ ok: true });
	});

	it("never lets a registry claim and a shard claim below it both stand, made at once across the switch", async () => {
		const before = await registry();
		await shard();
		for (let round = 0; round < 3; round++) {
			const outcomes = await Promise.all([
				(await store(before)).claim(want(`wide-${round}`, [`r${round}/`])),
				(await store()).claim(want(`deep-${round}`, [`r${round}/a/x.ts`])),
			]);
			expect(outcomes.filter((o) => o.ok).length).toBeLessThanOrEqual(1);
		}
		const held = (await (await store()).read()).claims;
		for (const a of held)
			for (const b of held)
				if (a !== b)
					for (const p of a.paths)
						for (const q of b.paths) expect(entriesOverlap(p, q), `${a.change} and ${b.change}`).toBe(false);
	});

	it("writes a claim spread over many shards once, in the shard holding them all", async () => {
		await shard();
		const examples = ["a", "b", "c", "d", "e", "f"].map((x) => `examples/${x}/index.js`);
		expect(await (await store()).claim(want("ex-1", examples))).toMatchObject({ ok: true });
		expect(shardRefs()).toEqual(["examples"]);
		// Under it, refused; beside it, fine.
		expect(await (await store()).claim(want("c-1", ["examples/c/index.js"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "ex-1" }],
		});
		expect(await (await store()).claim(want("g-1", ["examples/g/index.js"]))).toMatchObject({ ok: true });
		expect(await (await store()).release({ change: "ex-1", agent: "agent-ex-1", reason: "done" })).toEqual({
			ok: true,
		});
		expect(await active()).toEqual([["g-1", ["examples/g/index.js"]]]);
	});

	it("refuses a claim spread wide over a claim already held below, and backs it out", async () => {
		await shard();
		await (await store()).claim(want("b-1", ["examples/b/index.js"]));
		const examples = ["a", "b", "c", "d", "e"].map((x) => `examples/${x}/index.js`);
		expect(await (await store()).claim(want("ex-1", examples))).toMatchObject({
			ok: false,
			conflicts: [{ change: "b-1" }],
		});
		expect(await active()).toEqual([["b-1", ["examples/b/index.js"]]]);
	});

	it("writes a claim spread over the whole tree in the registry, which checks every shard", async () => {
		await shard();
		await (await store()).claim(want("lib-1", ["lib/router/index.js"]));
		const spread = ["lib/x.js", "test/y.js", "docs/z.md", "bin/w", "src/v.ts"];
		expect(await (await store()).claim(want("all-1", spread))).toMatchObject({ ok: true });
		const refused = await (await store()).claim(want("all-2", ["test/y.js", "docs/q.md", "bin/", "src/", "examples/"]));
		expect(refused.ok).toBe(false);
		expect(new Set(!refused.ok ? refused.conflicts.map((c) => c.path) : [])).toEqual(
			new Set(["test/y.js", "bin/", "src/"]),
		);
		expect(await (await store()).claim(want("t-1", ["test/y.js"]))).toMatchObject({
			ok: false,
			conflicts: [{ change: "all-1" }],
		});
		expect((await registry())?.claims.map((c) => c.change)).toEqual(["all-1"]);
	});

	it('cites the registry, as "", with the shards a merge checked', async () => {
		await (await store()).claim(want("a-1", ["src/a/"]));
		await shard();
		await (await store()).claim(want("b-1", ["src/b/"]));
		const s = await store();
		const view = await s.readScope("b-1", ["src/b/x.ts"]);
		expect(
			s.cite(
				view,
				["src/b/x.ts"],
				view.claims.find((c) => c.change === "b-1"),
			),
		).toBe(`=${view.tips.get("")} src%2Fb=${view.tips.get("src/b")}`);
	});
	it("reads several changes' scopes at once, as each alone would, listing the records once", async () => {
		await (await store()).claim(want("a-1", ["src/a/"]));
		await shard();
		await (await store()).claim(want("b-1", ["src/b/"]));
		await (await store()).claim(want("c-1", ["lib/c/"]));
		const scopes = [
			{ change: "a-1", files: ["src/a/x.ts"] },
			{ change: "b-1", files: ["src/b/x.ts"] },
			{ change: "c-1", files: ["lib/c/y.ts", "src/b/z.ts"] },
		];
		const listings = () => server.requests.filter((request) => request.startsWith("GET refs")).length;
		const alone = [];
		for (const scope of scopes) alone.push(await (await store()).readScope(scope.change, scope.files));
		const s = await store();
		const before = listings();
		const together = await s.readScopes(scopes);
		expect(together).toEqual(alone);
		// The registry once, then the indexes and the shards, all in the project repo here.
		expect(listings() - before).toBeLessThanOrEqual(3);
	});
});

describe("sharding on demand through the toolkit", { timeout: 120_000 }, () => {
	const { call, created } = shardingToolCalls(() => server);

	it("starts in one record, shards when the eighth agent claims, and audits clean across the switch", async () => {
		expect(await call("settings", { required: 1, vetoes: [] })).toMatchObject({ shardDepth: 0, sharding: "on demand" });
		for (let i = 0; i < SHARD_WHEN.agents - 1; i++)
			expect(
				await call("claim", { change: `c-${i}`, agent: `agent-${i}`, paths: [`area${i}/`], intent: "x" }),
			).toMatchObject({ ok: true });
		expect((await registry())?.shardDepth).toBeUndefined();
		expect(created).toEqual([]);
		// The eighth: sharded first, then claimed in its shard.
		expect(
			await call("claim", { change: "c-last", agent: "agent-last", paths: ["last/one/"], intent: "x" }),
		).toMatchObject({ ok: true });
		expect(await registry()).toMatchObject({
			shardDepth: 2,
			recordsRepos: 16,
			shardedBecause: `${SHARD_WHEN.agents} agents hold claims`,
		});
		expect(created).toEqual([16]);
		expect(((await call("claims", {})) as unknown as { change: string }[]).map((c) => c.change)).toContain("c-last");

		// A change claimed before the switch merges, citing the registry, and is released from it.
		const head = await pushChange(server.url, work, "agent-0", "c-0", { "area0/x.ts": "x\n" });
		await call("vote", { commit: head, reviewer: "rev-1", role: "review", verdict: "approve", evidence: "ok" });
		expect(await call("merge", { change: "c-0", agent: "agent-0" })).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Claims,valueonly)", "main").trim()).toMatch(
			/^=[0-9a-f]{40}$/,
		);
		// And one claimed after it, from its shard.
		const last = await pushChange(server.url, work, "agent-last", "c-last", { "last/one/y.ts": "y\n" });
		await call("vote", { commit: last, reviewer: "rev-1", role: "review", verdict: "approve", evidence: "ok" });
		expect(await call("merge", { change: "c-last", agent: "agent-last" })).toMatchObject({ ok: true });
		expect(await call("audit", {})).toEqual({ merges: 2, open: 0, violations: [] });
	});

	it("never shards a repo started with shard_depth 0", async () => {
		expect(await call("settings", { required: 1, vetoes: [], shard_depth: 0 })).toMatchObject({
			shardDepth: 0,
			sharding: "never",
		});
		for (let i = 0; i < SHARD_WHEN.agents + 1; i++)
			await call("claim", { change: `c-${i}`, agent: `agent-${i}`, paths: [`area${i}/`], intent: "x" });
		expect((await registry())?.shardDepth).toBeUndefined();
	});
});
