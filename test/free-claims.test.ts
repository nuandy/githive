import { describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { activeClaims, claim, release, releaseStale, startFree, type Registry } from "../src/free/claims";
import { startGitServer } from "./helpers/git-server";
import { MemoryLog } from "./helpers/memory-log";

// The coordinator-free claims registry: each agent checks for overlap itself and
// appends its claim by compare-and-swap. Nothing else decides.

const a = { change: "stats-1a2b", agent: "agent-a", paths: ["src/stats/"], intent: "Add stats" };
const b = { change: "fix-3c4d", agent: "agent-b", paths: ["src/stats/x.ts"], intent: "Fix x" };

describe("claims, coordinator-free", () => {
	it("claims free paths by appending to the registry", async () => {
		const log = new MemoryLog<Registry>();
		expect(await claim(log, a)).toMatchObject({ ok: true });
		const head = await log.read();
		expect(activeClaims(head!.commit.state)).toEqual([expect.objectContaining({ change: "stats-1a2b", agent: "agent-a", paths: ["src/stats/"] })]);
		expect(head!.commit.entries.map((e) => e.text)).toEqual(["agent-a claims src/stats/ for stats-1a2b: Add stats"]);
	});

	it("refuses an overlapping claim, naming the holder, and leaves the registry as it was", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		const commits = log.commits.length;
		expect(await claim(log, b)).toEqual({ ok: false, conflicts: [{ path: "src/stats/x.ts", held: "src/stats/", change: "stats-1a2b", agent: "agent-a", intent: "Add stats" }] });
		expect(log.commits).toHaveLength(commits);
	});

	it("lets Git settle two overlapping claims made at once: exactly one lands", async () => {
		const log = new MemoryLog<Registry>();
		// b's claim lands between a reading the registry and a appending to it.
		log.beforeAppend = async () => void (await claim(log, b));
		const outcome = await claim(log, a);
		expect(outcome).toMatchObject({ ok: false, conflicts: [{ change: "fix-3c4d", agent: "agent-b" }] });
		expect(activeClaims((await log.read())!.commit.state).map((c) => c.change)).toEqual(["fix-3c4d"]);
	});

	it("frees a released claim's paths for others", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		await release(log, { change: "stats-1a2b", agent: "agent-a", reason: "merged" });
		expect(await claim(log, b)).toMatchObject({ ok: true });
	});

	it("extends a change's own claim with free paths", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		expect(await claim(log, { ...a, paths: ["docs/stats.md"] })).toMatchObject({ ok: true });
		expect(activeClaims((await log.read())!.commit.state)[0].paths).toEqual(["src/stats/", "docs/stats.md"]);
	});

	it("on a real Git server, lets only one of two overlapping claims sent at once land", async () => {
		const server = await startGitServer();
		try {
			// Each agent has its own view of the registry, as separate agents would.
			const registry = () => new GitCasLog<Registry>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/blueprint-claims/t1");
			await claim(registry(), { change: "docs-9z9z", agent: "agent-c", paths: ["docs/"], intent: "Docs" });
			const released = server.holdPushes(2);
			const outcomes = await Promise.all([claim(registry(), a), claim(registry(), b)]);
			await released;
			expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
			expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
			const held = activeClaims((await registry().read())!.commit.state).map((c) => c.change).sort();
			expect(held.length).toBe(2);
			expect(held).toContain("docs-9z9z");
		} finally {
			await server.close();
		}
	});

	it("records which merge a release follows", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		await release(log, { change: "stats-1a2b", agent: "agent-a", reason: "merged", mergedAs: "m1" });
		expect((await log.read())!.commit.state.released).toEqual([expect.objectContaining({ change: "stats-1a2b", by: "agent-a", mergedAs: "m1" })]);
	});

	it("lets any agent release a claim gone stale, but not one still in use", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		const since = Date.parse((await log.read())!.commit.state.claims[0].active);
		expect(await releaseStale(log, { change: "stats-1a2b", agent: "agent-b", staleAfterMs: 60_000, now: since + 30_000 })).toMatchObject({ ok: false });
		expect(await releaseStale(log, { change: "stats-1a2b", agent: "agent-b", staleAfterMs: 60_000, now: since + 60_001 })).toMatchObject({ ok: true });
		expect(activeClaims((await log.read())!.commit.state)).toEqual([]);
		expect((await log.read())!.commit.state.released).toEqual([expect.objectContaining({ change: "stats-1a2b", by: "agent-b", stale: true })]);
	});

	it("counts extending a claim as activity", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, a);
		const first = (await log.read())!.commit.state.claims[0].active;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await claim(log, { ...a, paths: ["docs/stats.md"] });
		expect(Date.parse((await log.read())!.commit.state.claims[0].active)).toBeGreaterThan(Date.parse(first));
	});

	it("keeps the baseline, policy and checks through claims and releases", async () => {
		const log = new MemoryLog<Registry>();
		const started = { baseline: "b0", policy: { required: 2, vetoes: ["security"] }, verify: ["npm test"] };
		await startFree(log, started);
		await claim(log, a);
		await release(log, { change: "stats-1a2b", agent: "agent-a", reason: "merged", mergedAs: "m1" });
		await claim(log, b);
		await releaseStale(log, { change: "fix-3c4d", agent: "agent-a", staleAfterMs: 0, now: Date.now() + 1 });
		expect((await log.read())!.commit.state).toMatchObject(started);
	});
});
