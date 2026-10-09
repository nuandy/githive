import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/record-log";
import { statusOf } from "../src/errors";
import { claimStore } from "../src/toolkit/claim-store";
import { type ClaimRecord, type Registry, shardClaims } from "../src/toolkit/claims";
import { callTool, type ToolContext, repoSnapshot } from "../src/toolkit/mcp";
import type { VoteRecord } from "../src/toolkit/votes";
import { nextFor, type NextInput, type WorkItem, workId } from "../src/toolkit/work";
import { type ReviewHolds, reviewHolds, reviewsRef } from "../src/toolkit/review-holds";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Agents without set roles: next hands each the most useful work there
// is. Its own change first (merge, revise, finish), then a review someone is
// waiting for (never its own; a role that can block only if it holds it), then
// an untaken piece of the backlog, else wait. Nothing is reserved: the claim
// settles who builds what, so a change is only ever its first agent's.

const claimOf = (change: string, agent: string, since = "2026-10-07T10:00:00.000Z", paths = [`src/${change}/`]): ClaimRecord => ({ change, agent, paths, intent: `do ${change}`, since, active: since });
const vote = (commit: string, reviewer: string, verdict: "approve" | "reject" = "approve", role = "review"): VoteRecord => ({ commit, reviewer, role, verdict, evidence: verdict === "reject" ? "fix the edge case" : "ok", at: "" });
const item = (id: string): WorkItem => ({ id, title: id, intent: `build ${id}`, by: "planner", at: "" });
const base = (over: Partial<NextInput>): NextInput => ({ agent: "agent-x", policy: { required: 1, vetoes: [] }, open: [], votes: [], merged: new Set(), work: [], ...over });

describe("what an agent should do next", () => {
	it("merges its own approved change before anything else", () => {
		const next = nextFor(base({ open: [{ claim: claimOf("mine", "agent-x"), head: "h1" }, { claim: claimOf("theirs", "agent-y"), head: "h2" }], votes: [vote("h1", "agent-y")], work: [item("w1")] }));
		expect(next).toMatchObject({ kind: "merge", change: "mine", head: "h1" });
	});

	it("revises its own change before merging it over a reviewer who asked for changes, however many approved", () => {
		const open = [{ claim: claimOf("mine", "agent-x"), head: "h1" }];
		expect(nextFor(base({ open, votes: [vote("h1", "agent-y", "reject"), vote("h1", "agent-z")] }))).toMatchObject({ kind: "revise", change: "mine", reviewer: "agent-y" });
	});

	it("revises its own change a reviewer rejected, with their evidence; finishes one it never pushed", () => {
		expect(nextFor(base({ open: [{ claim: claimOf("mine", "agent-x"), head: "h1" }], votes: [vote("h1", "agent-y", "reject")] }))).toMatchObject({ kind: "revise", change: "mine", reviewer: "agent-y", evidence: "fix the edge case" });
		expect(nextFor(base({ open: [{ claim: claimOf("mine", "agent-x"), head: null }] }))).toMatchObject({ kind: "finish", change: "mine" });
	});

	it("reviews what others wait for: never its own, a commit it voted on, one rejected, or one approved", () => {
		const open = [
			{ claim: claimOf("own", "agent-x"), head: "h0" },
			{ claim: claimOf("voted", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" },
			{ claim: claimOf("rejected", "agent-y", "2026-10-07T09:01:00.000Z"), head: "h2" },
			{ claim: claimOf("approved", "agent-y", "2026-10-07T09:02:00.000Z"), head: "h3" },
			{ claim: claimOf("unpushed", "agent-y"), head: null },
			{ claim: claimOf("waiting", "agent-z", "2026-10-07T09:03:00.000Z"), head: "h4" },
		];
		const votes = [vote("h1", "agent-x"), vote("h2", "agent-w", "reject"), vote("h3", "agent-w")];
		expect(nextFor(base({ open, votes }))).toMatchObject({ kind: "review", change: "waiting", author: "agent-z", head: "h4", role: "review" });
	});

	it("leaves a review to the agents already on it, as many as it needs", () => {
		const open = [{ claim: claimOf("a", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" }, { claim: claimOf("b", "agent-y", "2026-10-07T09:01:00.000Z"), head: "h2" }];
		expect(nextFor(base({ open, held: { "h1#review": ["agent-z"] } }))).toMatchObject({ kind: "review", change: "b", needed: 1 });
		// The one it holds already comes back to it; both held by others: wait.
		expect(nextFor(base({ open, held: { "h1#review": ["agent-x"] } }))).toMatchObject({ kind: "review", change: "a" });
		expect(nextFor(base({ open, held: { "h2#review": ["agent-x"] } }))).toMatchObject({ kind: "review", change: "b" });
		expect(nextFor(base({ open, held: { "h1#review": ["agent-z"], "h2#review": ["agent-w"] } }))).toMatchObject({ kind: "wait" });
		// Two approvals needed: one agent on it leaves room for another.
		expect(nextFor(base({ policy: { required: 2, vetoes: [] }, open: [open[0]], held: { "h1#review": ["agent-z"] } }))).toMatchObject({ kind: "review", change: "a", needed: 2 });
	});

	it("asks for no more ordinary reviews than a change needs beside the role that can block it", () => {
		// Two approvals, security's among them: one ordinary review, then only the security holder.
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" }];
		expect(nextFor(base({ policy, open }))).toMatchObject({ kind: "review", change: "deps", role: "review", needed: 1 });
		expect(nextFor(base({ policy, open, held: { "h2#review": ["agent-w"] } }))).toMatchObject({ kind: "wait" });
		expect(nextFor(base({ policy, open, votes: [vote("h2", "agent-w")] }))).toMatchObject({ kind: "wait" });
		expect(nextFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")] }))).toMatchObject({ kind: "review", role: "security" });
	});

	it("doesn't let an ordinary reviewer's hold keep the holder of a role that can block away", () => {
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" }];
		// agent-w approved and its hold lingers; the security review is still the security holder's to do.
		expect(nextFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")], held: { "h2#review": ["agent-w"] } }))).toMatchObject({ kind: "review", role: "security" });
		expect(nextFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")], held: { "h2#security": ["other-sec"] } }))).toMatchObject({ kind: "wait" });
	});

	it("takes a role that can block only if it holds it, and those reviews first", () => {
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [
			{ claim: claimOf("plain", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" },
			{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" },
		];
		// The security holder reviews the change that needs it, though the other waits longer.
		expect(nextFor(base({ agent: "sec-agent", policy, open }))).toMatchObject({ kind: "review", change: "deps", role: "security" });
		// Anyone else: an ordinary review, wherever one is still needed; deps already has one approval of its two.
		expect(nextFor(base({ policy, open, votes: [vote("h1", "agent-w")] }))).toMatchObject({ kind: "review", change: "deps", role: "review" });
		// With deps' ordinary approvals in, only the security holder is asked.
		const deps = [vote("h1", "agent-w"), vote("h2", "agent-w"), vote("h2", "agent-v")];
		expect(nextFor(base({ policy, open, votes: deps, work: [item("w1")] }))).toMatchObject({ kind: "build" });
		expect(nextFor(base({ agent: "sec-agent", policy, open, votes: deps }))).toMatchObject({ kind: "review", change: "deps", role: "security" });
	});

	it("builds a piece of the backlog nobody has taken or merged, spreading agents over the first few", () => {
		const work = ["w1", "w2", "w3", "w4", "w5"].map(item);
		const open = [{ claim: claimOf("w1", "agent-y"), head: null }];
		const picks = new Set(Array.from({ length: 30 }, (_, i) => (nextFor(base({ agent: `agent-${i}`, open, work, merged: new Set(["w2"]) })) as { work: WorkItem }).work.id));
		expect([...picks].sort()).toEqual(["w3", "w4", "w5"]);
	});

	it("leaves its own change to a person once it asked one, and does other work meanwhile", () => {
		const open = [{ claim: claimOf("mine", "agent-x"), head: "h1" }];
		const votes = [vote("h1", "agent-y", "reject")];
		expect(nextFor(base({ open, votes, work: [item("w1")] }))).toMatchObject({ kind: "revise", change: "mine" });
		expect(nextFor(base({ open, votes, work: [item("w1")], asked: new Set(["mine"]) }))).toMatchObject({ kind: "build", work: { id: "w1" } });
	});

	it("holds back backlog items a claim in force overlaps, until it's gone", () => {
		const overlapping = { ...item("w-deep"), paths: ["src/held/x.ts"] };
		const open = [{ claim: claimOf("held", "agent-y"), head: null }];
		expect(nextFor(base({ open, work: [overlapping] }))).toMatchObject({ kind: "wait", reason: "the rest of the backlog (w-deep) overlaps claims in force" });
		expect(nextFor(base({ open: [], work: [overlapping] }))).toMatchObject({ kind: "build", work: { id: "w-deep" } });
	});

	it("waits, saying why, when there's nothing to do", () => {
		expect(nextFor(base({ open: [{ claim: claimOf("mine", "agent-x"), head: "h1" }] }))).toMatchObject({ kind: "wait", reason: "your mine waits for votes, and nothing else needs you" });
		expect(nextFor(base({}))).toMatchObject({ kind: "wait", reason: "no reviews are waiting and the backlog is empty" });
	});

	it("names work after its title", () => {
		expect(workId("Use const in lib/ — all of it!")).toBe("use-const-in-lib-all-of-it");
	});
});

describe("a crowd asking at once", () => {
	const agents = Array.from({ length: 40 }, (_, i) => `agent-${i}`);

	it("is spread over as many pieces of the backlog as there are agents, not the first few", () => {
		const work = Array.from({ length: 40 }, (_, i) => item(`w${i}`));
		const picks = agents.map((agent) => nextFor(base({ agent, work, crowd: agents.length }))).map((n) => (n.kind === "build" ? n.work.id : n.kind));
		expect(new Set(picks).size).toBeGreaterThan(15);
		// A small team still takes the backlog's first pieces.
		const few = ["a", "b"].map((agent) => nextFor(base({ agent, work, crowd: 2 }))).map((n) => (n.kind === "build" ? n.work.id : n.kind));
		expect(few.every((id) => ["w0", "w1", "w2"].includes(id))).toBe(true);
	});

	it("is spread over every review waiting alike", () => {
		const open = Array.from({ length: 20 }, (_, i) => ({ claim: claimOf(`c${i}`, "author", `2026-10-07T10:${String(i).padStart(2, "0")}:00.000Z`), head: `h${i}` }));
		const picks = agents.map((agent) => nextFor(base({ agent, open, crowd: agents.length }))).map((n) => (n.kind === "review" ? n.change : n.kind));
		expect(new Set(picks).size).toBeGreaterThan(10);
	});
});

describe("a change is its first agent's", { timeout: 60_000 }, () => {
	let server: GitServer;
	const remote = async () => ({ url: server.url, token: "unused" });
	const root = () => new GitCasLog<Registry>(remote, "p", "refs/notes/githive-claims/p");
	const store = async () => claimStore({ repo: "p", registry: (await root().read())?.commit.state, root: root(), remote });
	const want = (change: string, agent: string, paths: string[]) => ({ change, agent, paths, intent: change });
	beforeEach(async () => {
		server = await startGitServer();
	});
	afterEach(async () => {
		await server.close();
	});

	it("refuses another agent's claim under its name, in one record and in shards", async () => {
		expect(await (await store()).claim(want("w1", "agent-a", ["src/a/"]))).toMatchObject({ ok: true });
		await expect((await store()).claim(want("w1", "agent-b", ["src/a/x.ts"]))).rejects.toThrow("w1 is agent-a's change");
		await shardClaims(root(), { depth: 2, recordsRepos: 0, reason: "test" });
		// Claimed before sharding, extended after: still agent-a's.
		await expect((await store()).claim(want("w1", "agent-b", ["docs/b/"]))).rejects.toThrow("w1 is agent-a's change");
		expect(await (await store()).claim(want("w2", "agent-a", ["docs/w2/"]))).toMatchObject({ ok: true });
		await expect((await store()).claim(want("w2", "agent-b", ["lib/w2/"]))).rejects.toThrow("w2 is agent-a's change");
		expect(await (await store()).claim(want("w2", "agent-a", ["lib/w2/"]))).toMatchObject({ ok: true });
	});
});

describe("review holds through the toolkit", { timeout: 120_000 }, () => {
	it("sends two agents asking at once to different reviews, not both to the one", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-holds-"));
		try {
			// Holds kept as the record in Git, as the Worker keeps them.
			const reviews = reviewHolds((repo) => new GitCasLog<ReviewHolds>(async () => ({ url: server.url, token: "unused" }), repo, reviewsRef(repo)));
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				reviews,
				...(agentKey ? { agentKey } : {}),
			});
			const call = (name: string, args: Record<string, unknown>, key?: string) => callTool(name, { repo: "p", ...args }, ctx(key)) as Promise<Record<string, unknown>>;
			await call("start", { required: 1, vetoes: [] });
			const keys: Record<string, string> = {};
			for (const a of ["author", "rev-1", "rev-2"]) keys[a] = ((await call("register", { agent: a })) as { key: string }).key;
			const heads: string[] = [];
			for (const c of ["c-1", "c-2"]) {
				await call("claim", { change: c, agent: "author", paths: [`src/${c}/`], intent: c }, keys.author);
				heads.push(await pushChange(server.url, work, "author", c, { [`src/${c}/x.js`]: `${c}\n` }));
			}
			// A hold that can't be written (the record stayed busy) isn't taken: the review isn't handed out.
			const failing = callTool("next", { repo: "p", agent: "rev-1" }, { ...ctx(keys["rev-1"]), reviews: { ...reviews, hold: async () => { throw new Error("the Git server stayed busy"); } } });
			expect(await failing).toMatchObject({ kind: "wait" });
			const [one, two] = await Promise.all(["rev-1", "rev-2"].map((a) => call("next", { agent: a }, keys[a])));
			expect(one.kind).toBe("review");
			expect(two.kind).toBe("review");
			expect(new Set([one.change, two.change]).size).toBe(2);
			// A third finds both held, and waits.
			keys["rev-3"] = ((await call("register", { agent: "rev-3" })) as { key: string }).key;
			expect(await call("next", { agent: "rev-3" }, keys["rev-3"])).toMatchObject({ kind: "wait" });
			// rev-1 votes: its hold runs out a minute later (until the vote shows everywhere), not 15 minutes later.
			await call("vote", { commit: one.head, reviewer: "rev-1", role: "review", verdict: "approve", evidence: "ok" }, keys["rev-1"]);
			const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
			try {
				expect(Object.keys(await reviews.held("p"))).toEqual([`${two.head}#review`]);
			} finally {
				later.mockRestore();
			}
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("warming the checks when a merge is near", { timeout: 60_000 }, () => {
	it("warms at the start, after a check and after an approval; without checks, for landing, from the claim on too", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-warm-"));
		try {
			const warmed: unknown[] = [];
			const heads: Record<string, string> = {};
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				warmChecks: async (_repo, input) => void warmed.push(input),
				...(agentKey ? { agentKey } : {}),
			});
			const call = (repo: string, name: string, args: Record<string, unknown>, key?: string) => callTool(name, { repo, ...args }, ctx(key)) as Promise<Record<string, unknown>>;
			for (const [repo, verify] of [["checked", ["npm test"]], ["unchecked", []]] as const) {
				await call(repo, "start", { required: 1, vetoes: [], verify });
				const { key } = (await call(repo, "register", { agent: `a-${repo}` })) as { key: string };
				await call(repo, "claim", { change: `c-${repo}`, agent: `a-${repo}`, paths: [`src/${repo}/`], intent: "x" }, key);
				const head = await pushChange(server.url, work, `a-${repo}`, `c-${repo}`, { [`src/${repo}/x.js`]: "x\n" });
				heads[repo] = head;
				await call(repo, "check", { change: `c-${repo}` }, key);
				await call(repo, "vote", { commit: head, reviewer: "rev", role: "review", verdict: "approve", evidence: "ok" });
				await call(repo, "vote", { commit: head, reviewer: "rev-2", role: "review", verdict: "reject", evidence: "no" });
			}
			// The start, the check and the approval warm, each saying what merge to expect; the rejection doesn't. Without checks
			// the repo's Gate still lands the batch: it warms at the start (for the snapshot a cold Gate restores) and from the
			// claim on (the Gate passes over these once it has the snapshot).
			expect(warmed).toEqual([
				{ branch: "main", checks: ["npm test"], expect: "set up" },
				{ branch: "main", checks: ["npm test"], expect: "checked", key: "c-checked" },
				{ branch: "main", checks: ["npm test"], expect: "approved", key: heads.checked },
				{ branch: "main", checks: [], expect: "set up" },
				{ branch: "main", checks: [], expect: "claimed", key: "c-unchecked" },
				{ branch: "main", checks: [], expect: "checked", key: "c-unchecked" },
				{ branch: "main", checks: [], expect: "approved", key: heads.unchecked },
			]);
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("a review a role waits for too long", { timeout: 120_000 }, () => {
	it("is flagged to people once, clears once the role signs it off, and never holds up the author", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-role-wait-"));
		try {
			const reviews = reviewHolds((repo) => new GitCasLog<ReviewHolds>(async () => ({ url: server.url, token: "unused" }), repo, reviewsRef(repo)));
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				reviews,
				...(agentKey ? { agentKey } : {}),
			});
			const call = (name: string, args: Record<string, unknown>, key?: string) => callTool(name, { repo: "p", ...args }, ctx(key)) as Promise<Record<string, unknown>>;
			await call("start", { required: 1, vetoes: ["security"], grants: { security: ["sec-1", "person:*"] } });
			const keys: Record<string, string> = {};
			for (const a of ["author", "rev", "sec-1"]) keys[a] = ((await call("register", { agent: a })) as { key: string }).key;
			await call("claim", { change: "c-1", agent: "author", paths: ["src/c/"], intent: "c" }, keys.author);
			const head = await pushChange(server.url, work, "author", "c-1", { "src/c/x.js": "x\n" });
			await call("vote", { commit: head, reviewer: "rev", role: "review", verdict: "approve", evidence: "ok" }, keys.rev);
			// The clock starts when someone first asks; nothing is told before 10 minutes.
			await call("next", { agent: "rev" }, keys.rev);
			const snapshot = async () => (await repoSnapshot(ctx(), "p")).claims[0].attention;
			expect(await snapshot()).toBeUndefined();
			const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
			try {
				await call("next", { agent: "rev" }, keys.rev);
				await call("next", { agent: "rev" }, keys.rev);
				expect(await snapshot()).toMatchObject({ agent: "githive", reason: expect.stringMatching(/c-1's security review has waited 11 minutes .* You can review it as security from the dashboard/) });
				// Told once only.
				expect((await call("status", { change: "c-1" })).votes).toHaveLength(1);
			} finally {
				later.mockRestore();
			}
			// The flag doesn't stop the author: once security signs off, it merges, and the flag is gone.
			await call("vote", { commit: head, reviewer: "sec-1", role: "security", verdict: "approve", evidence: "ok" }, keys["sec-1"]);
			expect(await snapshot()).toBeUndefined();
			expect(await call("next", { agent: "author" }, keys.author)).toMatchObject({ kind: "merge", change: "c-1" });
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("open changes' heads, as GitHive last saw them", { timeout: 120_000 }, () => {
	it("reads a few unseen ones a call, none once all were seen lately, takes check's, and keeps one a failed read can't tell", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-heads-"));
		try {
			const known = new Map<string, { head: string | null; at: number }>();
			let forkReads = 0;
			let failing = "";
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				changeRemote: async (_repo, agent) => {
					forkReads++;
					if (agent === failing) throw new Error("[500] Artifacts is busy");
					return { url: server.url, token: "unused" };
				},
				head: async () => server.git("rev-parse", "main").trim(),
				knownHeads: async (_repo, changes) => Object.fromEntries(changes.flatMap((c) => (known.has(c) ? [[c, known.get(c)!]] : []))),
				noteHeads: async (_repo, seen) => void Object.entries(seen).forEach(([c, head]) => known.set(c, { head, at: Date.now() })),
				...(agentKey ? { agentKey } : {}),
			});
			const call = async (name: string, args: Record<string, unknown>, key?: string) => (await callTool(name, { repo: "p", ...args }, ctx(key))) as Record<string, unknown>;
			await call("start", { required: 1, vetoes: [] });
			const agents = Array.from({ length: 10 }, (_, i) => `a${i}`);
			const keys: Record<string, string> = {};
			for (const agent of [...agents, "z"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
			for (const agent of agents) {
				await call("claim", { change: `c-${agent}`, agent, paths: [`src/${agent}/`], intent: "x" }, keys[agent]);
				await pushChange(server.url, work, agent, `c-${agent}`, { [`src/${agent}/x.js`]: `${agent}\n` });
			}
			// None seen yet: each call reads 6 of them, then the rest, then none.
			const readsOf = async () => {
				const before = forkReads;
				await call("next", { agent: "z" }, keys.z);
				return forkReads - before;
			};
			expect(await readsOf()).toBe(6);
			expect(await readsOf()).toBe(4);
			expect(await readsOf()).toBe(0);
			expect(known.size).toBe(10);
			// A new push, checked: the head check read is noted, and next takes it without reading the fork.
			const newer = await pushChange(server.url, work, "a0", "c-a0", { "src/a0/x.js": "again\n" }, "origin/changes/c-a0");
			await call("check", { change: "c-a0" }, keys.a0);
			expect(known.get("c-a0")?.head).toBe(newer);
			expect(await readsOf()).toBe(0);
			// Seen long ago, and its read fails: what was seen stays, not "nothing pushed".
			const seen = known.get("c-a1")!;
			known.set("c-a1", { ...seen, at: 0 });
			failing = "a1";
			expect(await readsOf()).toBe(1);
			expect(known.get("c-a1")).toEqual({ ...seen, at: 0 });
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("next through the toolkit", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-next-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("hands two agents with no roles the backlog, then each other's reviews, then their merges", async () => {
		const ctx = (agentKey?: string): ToolContext => ({
			remote: async () => ({ url: server.url, token: "unused" }),
			changeRemote: async () => ({ url: server.url, token: "unused" }),
			head: async () => server.git("rev-parse", "main").trim(),
			...(agentKey ? { agentKey } : {}),
		});
		const call = async (name: string, args: Record<string, unknown>, key?: string) => {
			try {
				return (await callTool(name, { repo: "p", ...args }, ctx(key))) as Record<string, unknown> & { kind?: string; work?: WorkItem };
			} catch (err) {
				return { error: statusOf(err).message };
			}
		};
		await call("start", { required: 1, vetoes: [] });
		const keys = Object.fromEntries(await Promise.all(["agent-a", "agent-b"].map(async (a) => [a, ((await call("register", { agent: a })) as { key: string }).key])));
		expect(await call("add_work", { title: "Add the greeting", intent: "a greeting module", paths: ["src/greet/"], agent: "agent-a" }, keys["agent-a"])).toEqual({ ok: true, id: "add-the-greeting" });
		expect(await call("add_work", { title: "Add the farewell", intent: "a farewell module", paths: ["src/bye/"], agent: "agent-a" }, keys["agent-a"])).toEqual({ ok: true, id: "add-the-farewell" });
		expect(await call("add_work", { title: "Add the farewell", intent: "again", agent: "agent-a" }, keys["agent-a"])).toEqual({ ok: false, reason: "add-the-farewell is in the backlog already" });

		// Each builds a piece; if both were told the same, the claim decides and the other asks again.
		const built: Record<string, string> = {};
		for (const agent of ["agent-a", "agent-b"]) {
			for (;;) {
				const next = await call("next", { agent }, keys[agent]);
				expect(next.kind).toBe("build");
				const claimed = await call("claim", { change: next.work!.id, agent, paths: next.work!.paths, intent: next.work!.intent }, keys[agent]);
				if (claimed.ok) {
					built[agent] = next.work!.id;
					break;
				}
				expect(claimed.error).toMatch(/is agent-a's change/);
			}
		}
		expect(new Set(Object.values(built)).size).toBe(2);
		const heads: Record<string, string> = {};
		for (const agent of ["agent-a", "agent-b"]) heads[agent] = await pushChange(server.url, work, agent, built[agent], { [`src/${built[agent] === "add-the-greeting" ? "greet" : "bye"}/index.js`]: `${agent}\n` });

		// a reviews b's change; then b's best step is merging its own, approved; then b reviews a's; then a merges.
		const review = async (agent: string, other: string) => {
			expect(await call("next", { agent }, keys[agent])).toMatchObject({ kind: "review", change: built[other], author: other, head: heads[other], role: "review" });
			await call("vote", { commit: heads[other], reviewer: agent, role: "review", verdict: "approve", evidence: "read it" }, keys[agent]);
		};
		const merge = async (agent: string) => {
			expect(await call("next", { agent }, keys[agent])).toMatchObject({ kind: "merge", change: built[agent] });
			expect(await call("merge", { change: built[agent], agent }, keys[agent])).toMatchObject({ ok: true });
		};
		await review("agent-a", "agent-b");
		await merge("agent-b");
		await review("agent-b", "agent-a");
		await merge("agent-a");
		expect(await call("next", { agent: "agent-a" }, keys["agent-a"])).toMatchObject({ kind: "wait", reason: "no reviews are waiting and the backlog is empty" });
	});
});
