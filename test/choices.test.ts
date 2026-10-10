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
import { backlogFor, reviewsFor, type WorkInput, type WorkItem, workId } from "../src/toolkit/work";
import { memoryLanding } from "../src/toolkit/landing";
import { type ReviewHolds, reviewHolds, reviewsRef } from "../src/toolkit/review-holds";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// Agents without set roles look and choose: reviews lists the reviews an
// agent may give (never its own; a role that can block only if it holds it),
// backlog the pieces free to build. Equals come in an order of each agent's
// own, so a crowd looking at once spreads out. Nothing is reserved: the claim
// settles who builds what, so a change is only ever its first agent's.

const claimOf = (change: string, agent: string, since = "2026-10-07T10:00:00.000Z", paths = [`src/${change}/`]): ClaimRecord => ({ change, agent, paths, intent: `do ${change}`, since, active: since });
const vote = (commit: string, reviewer: string, verdict: "approve" | "reject" = "approve", role = "review"): VoteRecord => ({ commit, reviewer, role, verdict, evidence: verdict === "reject" ? "fix the edge case" : "ok", at: "" });
const item = (id: string): WorkItem => ({ id, title: id, intent: `build ${id}`, by: "planner", at: "" });
const base = (over: Partial<WorkInput>): WorkInput => ({ agent: "agent-x", policy: { required: 1, vetoes: [] }, open: [], votes: [], merged: new Set(), work: [], ...over });
const changes = (input: WorkInput) => reviewsFor(input).map((r) => r.change);

describe("the reviews an agent may give", () => {
	it("never its own, a commit it voted on, one sent back, one approved or one not pushed", () => {
		const open = [
			{ claim: claimOf("own", "agent-x"), head: "h0" },
			{ claim: claimOf("voted", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" },
			{ claim: claimOf("rejected", "agent-y", "2026-10-07T09:01:00.000Z"), head: "h2" },
			{ claim: claimOf("approved", "agent-y", "2026-10-07T09:02:00.000Z"), head: "h3" },
			{ claim: claimOf("unpushed", "agent-y"), head: null },
			{ claim: claimOf("waiting", "agent-z", "2026-10-07T09:03:00.000Z"), head: "h4" },
		];
		const votes = [vote("h1", "agent-x"), vote("h2", "agent-w", "reject"), vote("h3", "agent-w")];
		expect(reviewsFor(base({ open, votes }))).toEqual([{ change: "waiting", author: "agent-z", head: "h4", role: "review", blocking: false, intent: "do waiting", paths: ["src/waiting/"], approvals: 0, needed: 1, reviewing: [] }]);
	});

	it("leaves out one that agents already on it cover, and lists the one it's reviewing first", () => {
		const open = [{ claim: claimOf("a", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" }, { claim: claimOf("b", "agent-y", "2026-10-07T09:01:00.000Z"), head: "h2" }];
		expect(changes(base({ open, held: { "h1#review": ["agent-z"] } }))).toEqual(["b"]);
		expect(changes(base({ open, held: { "h2#review": ["agent-x"] } }))[0]).toBe("b");
		expect(changes(base({ open, held: { "h1#review": ["agent-z"], "h2#review": ["agent-w"] } }))).toEqual([]);
		// Two approvals needed: one agent on it leaves room for another, and says who.
		expect(reviewsFor(base({ policy: { required: 2, vetoes: [] }, open: [open[0]], held: { "h1#review": ["agent-z"] } }))).toMatchObject([{ change: "a", needed: 2, reviewing: ["agent-z"] }]);
	});

	it("asks for no more ordinary reviews than a change needs beside the role that can block it", () => {
		// Two approvals, security's among them: one ordinary review, then only the security holder.
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" }];
		expect(reviewsFor(base({ policy, open }))).toMatchObject([{ change: "deps", role: "review", needed: 1 }]);
		expect(reviewsFor(base({ policy, open, held: { "h2#review": ["agent-w"] } }))).toEqual([]);
		expect(reviewsFor(base({ policy, open, votes: [vote("h2", "agent-w")] }))).toEqual([]);
		expect(reviewsFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")] }))).toMatchObject([{ role: "security", blocking: true }]);
	});

	it("doesn't let an ordinary reviewer's hold keep the holder of a role that can block away", () => {
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" }];
		// agent-w approved and its hold lingers; the security review is still the security holder's to do.
		expect(reviewsFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")], held: { "h2#review": ["agent-w"] } }))).toMatchObject([{ role: "security" }]);
		expect(reviewsFor(base({ agent: "sec-agent", policy, open, votes: [vote("h2", "agent-w")], held: { "h2#security": ["other-sec"] } }))).toEqual([]);
	});

	it("offers a role that can block only to its holders, and those reviews first", () => {
		const policy = { required: 1, vetoes: [], escalate: [{ paths: ["package.json"], required: 2, vetoes: ["security"] }], grants: { security: ["sec-agent"] } };
		const open = [
			{ claim: claimOf("plain", "agent-y", "2026-10-07T09:00:00.000Z"), head: "h1" },
			{ claim: claimOf("deps", "agent-y", "2026-10-07T09:30:00.000Z", ["package.json"]), head: "h2" },
		];
		// The security holder sees the change that needs it first, though the other waits longer.
		expect(reviewsFor(base({ agent: "sec-agent", policy, open }))).toMatchObject([{ change: "deps", role: "security" }, { change: "plain", role: "review" }]);
		// Anyone else: ordinary reviews only; with deps' ordinary approvals in, only the security holder is offered it.
		const deps = [vote("h1", "agent-w"), vote("h2", "agent-w"), vote("h2", "agent-v")];
		expect(reviewsFor(base({ policy, open, votes: deps }))).toEqual([]);
		expect(reviewsFor(base({ agent: "sec-agent", policy, open, votes: deps }))).toMatchObject([{ change: "deps", role: "security" }]);
	});
});

describe("the backlog as an agent may take it", () => {
	it("is what nobody has claimed, nor its paths, and whose dependencies merged; the rest say why", () => {
		const work = [item("w1"), item("w2"), { ...item("w3"), paths: ["src/held/x.ts"] }, { ...item("w4"), after: ["w5"] }, item("w5")];
		const open = [{ claim: claimOf("w1", "agent-y"), head: null }, { claim: claimOf("held", "agent-z"), head: null }];
		const backlog = backlogFor(base({ open, work, merged: new Set(["w2"]) }));
		expect(backlog.open.map((w) => w.id)).toEqual(["w5"]);
		expect(backlog.waiting).toEqual([
			{ id: "w1", reason: "claimed by agent-y" },
			{ id: "w3", reason: "overlaps held's claim (agent-z)" },
			{ id: "w4", reason: "waits on w5 to merge" },
		]);
		// Once held is gone, w3 is free.
		expect(backlogFor(base({ work: [work[2]] })).open.map((w) => w.id)).toEqual(["w3"]);
	});

	it("frees a piece whose agent abandoned it, saying whose it was", () => {
		const open = [{ claim: claimOf("w1", "agent-y"), head: null }];
		expect(backlogFor(base({ open, work: [item("w1")], abandoned: new Set(["w1"]) })).open).toMatchObject([{ id: "w1", abandonedBy: "agent-y" }]);
	});

	it("names work after its title", () => {
		expect(workId("Use const in lib/ — all of it!")).toBe("use-const-in-lib-all-of-it");
	});
});

describe("a crowd looking at once", () => {
	const agents = Array.from({ length: 40 }, (_, i) => `agent-${i}`);

	it("starts at different pieces of the backlog", () => {
		const work = Array.from({ length: 40 }, (_, i) => item(`w${i}`));
		const firsts = agents.map((agent) => backlogFor(base({ agent, work })).open[0].id);
		expect(new Set(firsts).size).toBeGreaterThan(15);
		// Each still sees all of it.
		expect(backlogFor(base({ agent: "agent-1", work })).open).toHaveLength(40);
	});

	it("starts at different reviews alike", () => {
		const open = Array.from({ length: 20 }, (_, i) => ({ claim: claimOf(`c${i}`, "author", `2026-10-07T10:${String(i).padStart(2, "0")}:00.000Z`), head: `h${i}` }));
		const firsts = agents.map((agent) => reviewsFor(base({ agent, open }))[0].change);
		expect(new Set(firsts).size).toBeGreaterThan(10);
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
	it("marks a review taken when an agent starts it, so others look elsewhere, until it votes", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-holds-"));
		try {
			// Holds kept as the record in Git, as the Worker keeps them.
			const reviews = reviewHolds((repo) => new GitCasLog<ReviewHolds>(async () => ({ url: server.url, token: "unused" }), repo, reviewsRef(repo)));
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
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
			const listed = async (agent: string) => ((await call("reviews", { agent }, keys[agent])) as { reviews: { change: string; head: string }[] }).reviews;
			expect((await listed("rev-1")).map((r) => r.change).sort()).toEqual(["c-1", "c-2"]);
			// A mark that can't be written (the record stayed busy) doesn't keep anyone from reviewing: it's only a mark.
			const busy = { ...reviews, hold: async () => { throw new Error("the Git server stayed busy"); } };
			expect(await callTool("review_access", { repo: "p", change: "c-1" }, { ...ctx(keys["rev-1"]), reviews: busy })).toMatchObject({ change: "c-1", head: heads[0] });
			// rev-1 starts c-1, rev-2 starts c-2: each marked, so a third sees neither.
			const one = (await call("review_access", { change: "c-1" }, keys["rev-1"])) as { head: string };
			const two = (await call("review_access", { change: "c-2" }, keys["rev-2"])) as { head: string };
			keys["rev-3"] = ((await call("register", { agent: "rev-3" })) as { key: string }).key;
			expect(await listed("rev-3")).toEqual([]);
			// rev-1 still sees its own, first.
			expect((await listed("rev-1"))[0].change).toBe("c-1");
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
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
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
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
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
			// The clock starts when someone first looks; nothing is told before 10 minutes.
			await call("reviews", { agent: "rev" }, keys.rev);
			const snapshot = async () => (await repoSnapshot(ctx(), "p")).claims[0].attention;
			expect(await snapshot()).toBeUndefined();
			const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
			try {
				await call("reviews", { agent: "rev" }, keys.rev);
				await call("reviews", { agent: "rev" }, keys.rev);
				expect(await snapshot()).toMatchObject({ agent: "githive", reason: expect.stringMatching(/c-1's security review has waited 11 minutes .* You can review it as security from the dashboard/) });
				// Told once only.
				expect((await call("status", { change: "c-1" })).votes).toHaveLength(1);
			} finally {
				later.mockRestore();
			}
			// The flag doesn't stop the author: once security signs off, it merges, and the flag is gone.
			await call("vote", { commit: head, reviewer: "sec-1", role: "security", verdict: "approve", evidence: "ok" }, keys["sec-1"]);
			expect(await snapshot()).toBeUndefined();
			expect(await call("status", { change: "c-1" }, keys.author)).toMatchObject({ approval: { approved: true } });
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("open changes' heads, as GitHive last saw them", { timeout: 120_000 }, () => {
	it("reads a few unseen ones a call, none once all were seen lately, takes check's, keeps one a failed read can't tell, and trusts a pushed one longer", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-heads-"));
		try {
			const known = new Map<string, { head: string | null; at: number; pushed?: boolean }>();
			let forkReads = 0;
			let failing = "";
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
				changeRemote: async (_repo, agent) => {
					forkReads++;
					if (agent === failing) throw new Error("[500] Artifacts is busy");
					return { url: server.url, token: "unused" };
				},
				head: async () => server.git("rev-parse", "main").trim(),
				knownHeads: async (_repo, claims) => Object.fromEntries(claims.flatMap(({ change: c }) => (known.has(c) ? [[c, known.get(c)!]] : []))),
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
			// None seen yet: each look reads 6 of them, then the rest, then none.
			const readsOf = async () => {
				const before = forkReads;
				await call("reviews", { agent: "z" }, keys.z);
				return forkReads - before;
			};
			expect(await readsOf()).toBe(6);
			expect(await readsOf()).toBe(4);
			expect(await readsOf()).toBe(0);
			expect(known.size).toBe(10);
			// A new push, checked: the head check read is noted, and reviews takes it without reading the fork.
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
			failing = "";
			expect(await readsOf()).toBe(1);
			// A head a push event told of counts for half an hour, one read for five minutes.
			const told = known.get("c-a2")!;
			known.set("c-a2", { ...told, at: Date.now() - 10 * 60_000, pushed: true });
			expect(await readsOf()).toBe(0);
			known.set("c-a2", { ...told, at: Date.now() - 31 * 60_000, pushed: true });
			expect(await readsOf()).toBe(1);
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("news of main moving", { timeout: 120_000 }, () => {
	it("comes with every reply that's an object, saying what changed, by whom and why; a list stays a list", async () => {
		const server = await startGitServer();
		try {
			const asked: string[] = [];
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				news: async (_repo, branch, agent) => (asked.push(`${branch} ${agent}`), [{ change: "c-7", agent: "agent-b", at: "2026-10-10T10:00:00.000Z", commit: "2f56723d0000", files: ["src/billing/invoice.ts"], intent: "add partial refunds" }]),
				...(agentKey ? { agentKey } : {}),
			});
			const call = async (name: string, args: Record<string, unknown>, key?: string) => callTool(name, { repo: "p", ...args }, ctx(key));
			await call("start", { required: 1, vetoes: [] });
			const { key } = (await call("register", { agent: "agent-a" })) as { key: string };
			expect(await call("backlog", { agent: "agent-a" }, key)).toMatchObject({ open: [], news: [{ change: "c-7", says: 'main changed src/billing/invoice.ts: c-7 by agent-b, "add partial refunds"' }] });
			expect(Array.isArray(await call("claims", {}, key))).toBe(true);
			expect(asked).toContain("main agent-a");
		} finally {
			await server.close();
		}
	});
});

describe("a change that landed before its claim was released", { timeout: 120_000 }, () => {
	it("is offered for review no more, and its piece of the backlog counts as merged", async () => {
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-landed-"));
		try {
			const landing = memoryLanding();
			const ctx = (agentKey?: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				landing: () => landing,
				...(agentKey ? { agentKey } : {}),
			});
			const call = async (name: string, args: Record<string, unknown>, key?: string) => (await callTool(name, { repo: "p", ...args }, ctx(key))) as Record<string, unknown>;
			await call("start", { required: 1, vetoes: [] });
			const keys: Record<string, string> = {};
			for (const agent of ["a", "b"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
			await call("add_work", { id: "c-1", title: "c-1", intent: "x", paths: ["src/a/"], agent: "a" }, keys.a);
			await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "x" }, keys.a);
			const head = await pushChange(server.url, work, "a", "c-1", { "src/a/x.js": "a\n" });
			expect(await call("reviews", { agent: "b" }, keys.b)).toMatchObject({ reviews: [{ change: "c-1", head }] });
			// Landed in a batch; its claim is released only once the lease is handed on.
			await landing.settle([{ change: "c-1", head, agent: "a", how: "landed", at: new Date().toISOString(), commit: "m1" }]);
			expect(await call("reviews", { agent: "b" }, keys.b)).toEqual({ reviews: [] });
			expect(await call("backlog", { agent: "b" }, keys.b)).toEqual({ open: [], waiting: [] });
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("agents choosing through the toolkit", { timeout: 120_000 }, () => {
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

	it("lets two agents with no roles build from the backlog, review each other's, and merge", async () => {
		const ctx = (agentKey?: string): ToolContext => ({
			remote: async () => ({ url: server.url, token: "unused" }),
			batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
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

		// Each builds a piece it picks from the backlog; if both picked the same, the claim decides and the other picks again.
		const built: Record<string, string> = {};
		for (const agent of ["agent-a", "agent-b"]) {
			for (;;) {
				const { open } = (await call("backlog", { agent }, keys[agent])) as unknown as { open: WorkItem[] };
				const pick = open[0];
				const claimed = await call("claim", { change: pick.id, agent, paths: pick.paths, intent: pick.intent }, keys[agent]);
				if (claimed.ok) {
					built[agent] = pick.id;
					break;
				}
			}
		}
		expect(new Set(Object.values(built)).size).toBe(2);
		const heads: Record<string, string> = {};
		for (const agent of ["agent-a", "agent-b"]) heads[agent] = await pushChange(server.url, work, agent, built[agent], { [`src/${built[agent] === "add-the-greeting" ? "greet" : "bye"}/index.js`]: `${agent}\n` });

		// a reviews b's change; b sees its own approved and merges it; then b reviews a's; then a merges.
		const review = async (agent: string, other: string) => {
			expect(await call("reviews", { agent }, keys[agent])).toMatchObject({ reviews: [{ change: built[other], author: other, head: heads[other], role: "review" }] });
			await call("review_access", { change: built[other] }, keys[agent]);
			await call("vote", { commit: heads[other], reviewer: agent, role: "review", verdict: "approve", evidence: "read it" }, keys[agent]);
		};
		const merge = async (agent: string) => {
			expect(await call("status", { change: built[agent] }, keys[agent])).toMatchObject({ head: heads[agent], approval: { approved: true } });
			expect(await call("merge", { change: built[agent], agent }, keys[agent])).toMatchObject({ ok: true });
		};
		await review("agent-a", "agent-b");
		await merge("agent-b");
		await review("agent-b", "agent-a");
		await merge("agent-a");
		expect(await call("reviews", { agent: "agent-a" }, keys["agent-a"])).toEqual({ reviews: [] });
		expect(await call("backlog", { agent: "agent-a" }, keys["agent-a"])).toEqual({ open: [], waiting: [] });
	});
});
