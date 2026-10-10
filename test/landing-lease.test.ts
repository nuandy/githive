import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/record-log";
import { memoryLanding, type Landing, type Settled } from "../src/toolkit/landing";
import { gitLanding, landingRef, leaseHeld, type LeaseRecord } from "../src/toolkit/landing-lease";
import { startGitServer, type GitServer } from "./helpers/git-server";

// A branch's landing lease as a record in Git: of two merges at once only one
// takes it, it runs out unless its holder keeps it, and what the RepoCache
// keeps beside it (outcomes, checks passed, the batch read ahead) is a help
// whose failure never stops a merge.

let server: GitServer;
beforeAll(async () => {
	server = await startGitServer();
});
afterAll(async () => {
	await server?.close();
});

let refs = 0;
const leaseLog = () => new GitCasLog<LeaseRecord>(async () => ({ url: server.url, token: "unused" }), "p", landingRef("p", `main-${refs++}`));
/** A RepoCache that answers nothing. */
const unreachable = (): Omit<Landing, "turn" | "renew"> => {
	const down = () => Promise.reject(new Error("Durable Object is overloaded. Requests queued for too long."));
	return { drop: down, checking: down, settle: down, view: down };
};
const batch = { base: "b".repeat(40), since: "2026-10-10T00:00:00.000Z", changes: [{ change: "c1", head: "a".repeat(40), agent: "agent-1" }] };

describe("the landing lease in Git", { timeout: 60_000 }, () => {
	it("goes to one of two merges at once, is kept by its holder only, and is handed on", async () => {
		const log = leaseLog();
		const a = gitLanding(log, memoryLanding());
		const b = gitLanding(log, memoryLanding());
		const [ta, tb] = await Promise.all([a.turn("merge-a", "c1", "1".repeat(40), 0, 60_000), b.turn("merge-b", "c2", "2".repeat(40), 0, 60_000)]);
		expect([ta, tb].filter((t) => "lease" in t && t.lease)).toHaveLength(1);
		const [holder, other, waiting] = "lease" in ta && ta.lease ? (["merge-a", "merge-b", b] as const) : (["merge-b", "merge-a", a] as const);
		expect(await leaseHeld(log)).toBe(true);
		expect(await waiting.renew(other, 60_000)).toBe(false);
		// Plenty of it left: kept without a write.
		const tip = (await log.read())?.tip;
		expect(await waiting.renew(holder, 60_000)).toBe(true);
		expect((await log.read())?.tip).toBe(tip);
		// Asked to keep it longer than half of what's left: written.
		expect(await waiting.renew(holder, 10 * 60_000)).toBe(true);
		expect((await log.read())?.tip).not.toBe(tip);
		// Who's checking what is in the record too.
		await waiting.checking(batch);
		expect((await log.read())?.commit.state.checking).toEqual(batch);
		await waiting.drop(holder);
		expect(await leaseHeld(log)).toBe(false);
		expect((await log.read())?.commit.state.checking).toBeNull();
		expect(await waiting.turn(other, "c9", "9".repeat(40), 0, 60_000)).toEqual({ lease: true });
	});

	it("runs out unless kept, and a waiting merge takes it then", async () => {
		const log = leaseLog();
		const landing = gitLanding(log, memoryLanding());
		expect(await landing.turn("dead", "c1", "1".repeat(40), 0, 1_500)).toEqual({ lease: true });
		await landing.checking(batch);
		expect((await landing.view()).checking).toEqual(batch);
		expect(await landing.turn("alive", "c2", "2".repeat(40), 0, 60_000)).toEqual({ lease: false });
		await new Promise((resolve) => setTimeout(resolve, 1_600));
		// Its holder gone, what it showed as checking isn't: those changes can be found abandoned again.
		expect((await landing.view()).checking).toBeNull();
		expect(await landing.turn("alive", "c2", "2".repeat(40), 0, 60_000)).toEqual({ lease: true });
		expect(await landing.renew("dead", 60_000)).toBe(false);
	});

	it("tells a merge what its change came to, as the RepoCache recalls, before any lease", async () => {
		const kept = memoryLanding();
		const landed: Settled = { change: "c1", head: "1".repeat(40), agent: "agent-1", how: "landed", at: new Date().toISOString(), commit: "m".repeat(40) };
		await kept.settle([landed]);
		const log = leaseLog();
		expect(await gitLanding(log, kept).turn("merge-a", "c1", "1".repeat(40), 0, 60_000)).toEqual({ settled: landed });
		expect(await log.read()).toBeNull();
	});

	it("lands without the RepoCache: the lease from Git, and nothing it would have kept fails the merge", async () => {
		const log = leaseLog();
		const landing = gitLanding(log, unreachable());
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await landing.turn("merge-a", "c1", "1".repeat(40), 0, 60_000)).toEqual({ lease: true });
			await landing.checking(batch);
			expect((await log.read())?.commit.state.checking).toEqual(batch);
			await landing.settle([{ change: "c1", head: "1".repeat(40), agent: "agent-1", how: "landed", at: new Date().toISOString() }]);
			// What's being checked comes from the lease record; what changes came to, nowhere to recall it from.
			expect(await landing.view()).toEqual({ checking: batch, recent: [] });
			await landing.drop("merge-a");
			expect(await leaseHeld(log)).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});

	it("keeps a merge waiting, not failing, while the record can't be written", async () => {
		const failing = { read: async () => null, append: async () => Promise.reject(new Error("[503] the Git server stayed busy")), lastRefusal: null };
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await gitLanding(failing, memoryLanding()).turn("merge-a", "c1", "1".repeat(40), 0, 60_000)).toEqual({ lease: false });
		} finally {
			errors.mockRestore();
		}
	});
});
