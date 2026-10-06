import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { statusOf } from "../src/errors";
import { audit } from "../src/free/audit";
import { callFreeTool, type FreeContext } from "../src/free/mcp";
import { bucketOf, VOTE_BUCKETS, voteStore, votesPrefix } from "../src/free/vote-store";
import { openFlag, SHARD_VOTES_WHEN, shardVotes, type Votes, votesShardingReason } from "../src/free/votes";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Votes start in one record and are sharded when the load calls for it: new
// votes go to a bucket by commit, each its own ref. Votes never conflict, so
// the record keeps the votes cast before (and any cast there after, by a
// caller that read it before), and readers read it with the buckets they need.

let server: GitServer;
let work: string;
const remote = async () => ({ url: server.url, token: "unused" });
const rootRef = "refs/notes/blueprint-votes/p";
const root = () => new GitCasLog<Votes>(remote, "p", rootRef);
const store = (rootHead?: Awaited<ReturnType<GitCasLog<Votes>["read"]>>) => voteStore({ repo: "p", root: root(), remote, ...(rootHead !== undefined ? { rootHead } : {}) });
const refs = (prefix: string) => server.git("for-each-ref", "--format=%(refname)", prefix).trim().split("\n").filter(Boolean);
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const ballot = (commit: string, reviewer: string, verdict: "approve" | "reject" = "approve") => ({ commit, reviewer, role: "review", verdict, evidence: "ok" });

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "free-votes-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("when to shard the votes", () => {
	const at = Date.parse("2026-10-07T12:00:00.000Z");
	const cast = (n: number, when = at) => Array.from({ length: n }, (_, i) => ({ ...ballot(commitA, `rev-${i}`), at: new Date(when).toISOString() }));

	it("shards once as many reviewers vote at once as one record serves well", () => {
		expect(votesShardingReason({ votes: cast(SHARD_VOTES_WHEN.reviewers - 2) }, "newcomer", at)).toBeNull();
		expect(votesShardingReason({ votes: cast(SHARD_VOTES_WHEN.reviewers - 1) }, "newcomer", at)).toBe(`${SHARD_VOTES_WHEN.reviewers} reviewers voting`);
		expect(votesShardingReason({ votes: cast(SHARD_VOTES_WHEN.reviewers - 1) }, "rev-0", at)).toBeNull();
	});

	it("shards when votes come faster than one record serves well, counting only the last few minutes", () => {
		const window = SHARD_VOTES_WHEN.windowMs / 60_000;
		const many = (n: number, when = at) => Array.from({ length: n }, (_, i) => ({ ...ballot(commitA, `rev-${i % 3}`), at: new Date(when).toISOString() }));
		expect(votesShardingReason({ votes: many(SHARD_VOTES_WHEN.writesPerMinute * window) }, "rev-0", at)).toBeNull();
		expect(votesShardingReason({ votes: many(SHARD_VOTES_WHEN.writesPerMinute * window + 1) }, "rev-0", at)).toMatch(/votes a minute/);
		expect(votesShardingReason({ votes: many(200, at - SHARD_VOTES_WHEN.windowMs - 1) }, "rev-0", at)).toBeNull();
	});

	it("never shards votes that are sharded", () => {
		expect(votesShardingReason({ votes: cast(20), buckets: VOTE_BUCKETS }, "x", at)).toBeNull();
	});

	it("puts a commit's votes in one bucket, always the same", () => {
		expect(bucketOf(commitA, 16)).toBe(bucketOf(commitA, 16));
		const seen = new Set(Array.from({ length: 64 }, (_, i) => bucketOf(i.toString(16).padStart(6, "0") + "0".repeat(34), 16)));
		expect([...seen].every((b) => Number(b) >= 0 && Number(b) < 16)).toBe(true);
		expect(seen.size).toBe(16);
	});
});

describe("votes before and after sharding", { timeout: 60_000 }, () => {
	it("keeps every vote in one record until sharded, and cites its tip", async () => {
		await store().vote(ballot(commitA, "rev-1"));
		expect(refs("refs/notes/")).toEqual([rootRef]);
		const view = await store().readFor([commitA]);
		expect(view.votes.map((v) => v.reviewer)).toEqual(["rev-1"]);
		expect(store().cite(view, commitA)).toBe(view.tips.get(""));
	});

	it("shards once, keeping the votes cast before, and reads a commit's votes from the record and its bucket", async () => {
		await store().vote(ballot(commitA, "rev-1"));
		await store().flag({ change: "c-1", agent: "agent-c", reason: "reviewers disagree" });
		expect(await shardVotes(root(), { buckets: VOTE_BUCKETS, recordsRepos: 0, reason: "test" })).toMatchObject({ ok: true });
		expect(await shardVotes(root(), { buckets: VOTE_BUCKETS, recordsRepos: 0, reason: "test" })).toMatchObject({ ok: false, refused: "sharded" });
		await store().vote(ballot(commitA, "rev-2"));
		await store().vote(ballot(commitB, "rev-3"));
		// New votes went to their commits' buckets; the record kept the one from before (and the flag).
		expect(refs(votesPrefix("p")).map((r) => r.slice(votesPrefix("p").length)).sort()).toEqual([...new Set([bucketOf(commitA, VOTE_BUCKETS), bucketOf(commitB, VOTE_BUCKETS)])].sort());
		expect((await root().read())?.commit.state.votes.map((v) => v.reviewer)).toEqual(["rev-1"]);
		const forA = await store().readFor([commitA]);
		expect(forA.votes.filter((v) => v.commit === commitA).map((v) => v.reviewer)).toEqual(["rev-1", "rev-2"]);
		expect(forA.flags.map((f) => f.change)).toEqual(["c-1"]);
		expect((await store().read()).votes.map((v) => v.reviewer)).toEqual(["rev-1", "rev-2", "rev-3"]);
		// Cited: the record and the commit's bucket.
		expect(store().cite(forA, commitA)).toBe(`=${forA.tips.get("")} ${bucketOf(commitA, VOTE_BUCKETS)}=${forA.tips.get(bucketOf(commitA, VOTE_BUCKETS))}`);
	});

	it("still counts a vote cast in the record after sharding, by a caller that read it before", async () => {
		const before = await root().read();
		await store().vote(ballot(commitA, "rev-1"));
		await shardVotes(root(), { buckets: VOTE_BUCKETS, recordsRepos: 0, reason: "test" });
		await store(before).vote(ballot(commitA, "rev-late"));
		expect((await store().readFor([commitA])).votes.map((v) => v.reviewer)).toEqual(["rev-1", "rev-late"]);
	});

	it("answers a question for a person with a person's vote in a bucket", async () => {
		await store().flag({ change: "c-1", agent: "agent-c", reason: "a style call" });
		await shardVotes(root(), { buckets: VOTE_BUCKETS, recordsRepos: 0, reason: "test" });
		expect(openFlag(await store().readFor([commitA]), "c-1", commitA)).toMatchObject({ reason: "a style call" });
		await store().vote(ballot(commitA, "person:someone"), { by: "person:someone", stamp: async () => "s" } as never);
		expect(openFlag(await store().readFor([commitA]), "c-1", commitA)).toBeNull();
	});
});

describe("the audit of sharded votes", () => {
	const merge = (votesTip: string) => ({ commit: "m1", author: "agent-a", change: "c-1", claimsTip: "r1", head: commitA, votesTip, base: "b0", files: ["src/x.ts"] });
	const registry = [{ tip: "r1", state: { claims: [{ change: "c-1", agent: "agent-a", paths: ["src/"], intent: "x", since: "t", active: "t" }], released: [] } }];
	const vote = { ...ballot(commitA, "rev-1"), at: "2026-10-07T12:00:00.000Z" };

	it("counts the record and the cited bucket together", async () => {
		const records = { registry, votes: [{ tip: "v1", state: { votes: [] } }], voteBuckets: new Map([["5", [{ tip: "k1", state: { votes: [vote] } }]]]), policy: { required: 1, vetoes: [] }, merges: [merge("=v1 5=k1")] };
		expect(await audit(records)).toEqual([]);
	});

	it("reports a cited bucket tip that isn't in the bucket's history, and approvals the cited votes don't hold", async () => {
		const records = { registry, votes: [{ tip: "v1", state: { votes: [] } }], voteBuckets: new Map([["5", [{ tip: "k1", state: { votes: [vote] } }]]]), policy: { required: 1, vetoes: [] } };
		expect((await audit({ ...records, merges: [merge("=v1 5=nope")] })).map((v) => v.rule)).toContain("unknown-votes");
		// Citing only the record, whose votes don't approve it.
		expect((await audit({ ...records, merges: [merge("=v1")] })).map((v) => v.rule)).toContain("unapproved");
	});
});

describe("sharding votes on demand through the toolkit", { timeout: 120_000 }, () => {
	const created: number[] = [];
	const ctx = (): FreeContext => ({
		remote,
		changeRemote: remote,
		head: async () => server.git("rev-parse", "main").trim(),
		recordsRemote: async (_repo, k) => ({ url: server.repo(`rec-${k}`), token: "unused" }),
		createRecordsRepos: async (_repo, count) => void created.push(count),
	});
	const call = async (name: string, args: Record<string, unknown>) => {
		try {
			return (await callFreeTool(name, { repo: "p", ...args }, ctx())) as Record<string, unknown> & { ok?: boolean };
		} catch (err) {
			return { error: statusOf(err).message };
		}
	};

	it("shards the votes when the eighth reviewer votes, merges counting both, and audits clean", async () => {
		expect(await call("free_start", { required: 1, vetoes: [] })).toMatchObject({ sharding: "on demand" });
		expect(await call("free_claim", { change: "c-1", agent: "agent-a", paths: ["src/"], intent: "x" })).toMatchObject({ ok: true });
		const head = await pushChange(server.url, work, "agent-a", "c-1", { "src/x.ts": "x\n" });
		for (let i = 0; i < SHARD_VOTES_WHEN.reviewers - 1; i++) await call("free_vote", { commit: head, reviewer: `rev-${i}`, role: "review", verdict: "approve", evidence: "ok" });
		expect((await root().read())?.commit.state.buckets).toBeUndefined();
		// The eighth: sharded first, then cast in the commit's bucket.
		await call("free_vote", { commit: head, reviewer: "rev-last", role: "review", verdict: "reject", evidence: "not yet" });
		expect((await root().read())?.commit.state).toMatchObject({ buckets: VOTE_BUCKETS, recordsRepos: 8, shardedBecause: `${SHARD_VOTES_WHEN.reviewers} reviewers voting` });
		expect(created).toEqual([8]);
		expect(((await call("free_status", { change: "c-1" })) as { votes: { reviewer: string }[] }).votes.map((v) => v.reviewer)).toContain("rev-last");

		expect(await call("free_merge", { change: "c-1", agent: "agent-a" })).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%(trailers:key=Blueprint-Votes,valueonly)", "main").trim()).toMatch(new RegExp(`^=[0-9a-f]{40} ${bucketOf(head, VOTE_BUCKETS)}=[0-9a-f]{40}$`));
		expect(await call("free_audit", {})).toEqual({ merges: 1, open: 0, violations: [] });
	});
});
