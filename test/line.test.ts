import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { branchHead } from "../src/git";
import { audit, type MergeRecord } from "../src/toolkit/audit";
import { claimStore } from "../src/toolkit/claim-store";
import { claim, startRepo, type Registry } from "../src/toolkit/claims";
import { readMainMerges, readRecordHistory } from "../src/toolkit/git-records";
import { holdsPlace, joinLine, type Place, landedFromLine, leaveLine, type Line, lineCheckRunner, lineRef, MAX_LINE, markPassed, QUIET_MS } from "../src/toolkit/line";
import { type CheckRunner, mergeChange } from "../src/toolkit/merge";
import { voteStore } from "../src/toolkit/vote-store";
import { vote, type Votes } from "../src/toolkit/votes";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { MemoryLog } from "./helpers/memory-log";

// The line of merges (a merge queue) as a record in Git: each merge joins it
// by compare-and-swap and is checked on the line's tip after the merges ahead
// of it, side by side in its own container; it lands right after exactly
// those, and the audit checks that. A merge that leaves without landing takes
// the merges behind it along.

const join1 = (log: MemoryLog<Line>, change: string, main = "m0", now?: () => number) => joinLine(log, { change, head: `${change}-head`, agent: `agent-${change}`, main: async () => main }, now);
/** A place the line gave (a test that expects room). */
const placed = (place: Place | "full"): Place => {
	if (place === "full") throw new Error("the line was full");
	return place;
};
const state = async (log: MemoryLog<Line>) => (await log.read())!.commit.state;
const changes = async (log: MemoryLog<Line>) => (await state(log)).entries.map((e) => e.change);

describe("the line of merges, as a record", () => {
	it("checks the first merge on main, and each one after on the same main, after the ones ahead", async () => {
		const log = new MemoryLog<Line>();
		expect(await join1(log, "a")).toMatchObject({ base: "m0", ahead: [] });
		const b = await join1(log, "b", "m-later");
		expect(b).toMatchObject({ base: "m0", ahead: [{ change: "a", head: "a-head" }] });
		expect(await join1(log, "c")).toMatchObject({ base: "m0", ahead: [{ change: "a" }, { change: "b" }] });
	});

	it("moves the tip to each merge that lands: a merge joining after is checked on it", async () => {
		const log = new MemoryLog<Line>();
		const a = await join1(log, "a");
		await join1(log, "b");
		if (a === "full") throw new Error("full");
		expect(await landedFromLine(log, a.id, "m1")).toBe(true);
		expect(await join1(log, "c")).toMatchObject({ base: "m1", ahead: [{ change: "b" }] });
		expect((await state(log)).left).toMatchObject([{ change: "a", how: "landed", commit: "m1" }]);
	});

	it("takes the merges behind one that fails out of the line: they were checked after it", async () => {
		const log = new MemoryLog<Line>();
		const places: Place[] = [];
		for (const c of ["a", "b", "c", "d"]) places.push(placed(await join1(log, c)));
		await leaveLine(log, places[1].id, "failed");
		expect(await changes(log)).toEqual(["a"]);
		expect((await state(log)).left.map((l) => [l.change, l.how])).toEqual([
			["b", "failed"],
			["c", "behind one that left"],
			["d", "behind one that left"],
		]);
		expect(await holdsPlace(log, places[2].id)).toBe(false);
		// One joining now is checked after the merge still in line.
		expect(await join1(log, "c")).toMatchObject({ base: "m0", ahead: [{ change: "a" }] });
	});

	it("takes a merge that went quiet out of the line, with those behind it, when the next one joins", async () => {
		const log = new MemoryLog<Line>();
		const t0 = 1_000_000;
		await join1(log, "a", "m0", () => t0);
		await join1(log, "b", "m0", () => t0);
		const c = await join1(log, "c", "m0", () => t0 + QUIET_MS + 1);
		expect(c).toMatchObject({ base: "m0", ahead: [] });
		expect((await state(log)).left.map((l) => [l.change, l.how])).toEqual([
			["a", "went quiet"],
			["b", "behind one that left"],
		]);
	});

	it("gives up a change's earlier place when it joins again, and starts afresh from main once the line is empty", async () => {
		const log = new MemoryLog<Line>();
		await join1(log, "a");
		await join1(log, "b");
		expect(await join1(log, "a", "m5")).toMatchObject({ base: "m5", ahead: [] });
		expect(await changes(log)).toEqual(["a"]);
	});

	it("refuses a merge while the line is full, and marks a passing one", async () => {
		const log = new MemoryLog<Line>();
		const first = await join1(log, "c0");
		for (let i = 1; i < MAX_LINE; i++) await join1(log, `c${i}`);
		expect(await join1(log, "late")).toBe("full");
		if (first === "full") throw new Error("full");
		expect(await markPassed(log, first.id)).toBe(true);
		expect((await state(log)).entries[0].status).toBe("passed");
	});
});

describe("merging in line", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	const remote = () => ({ url: server.url, token: "unused" });
	const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/githive-claims/t1");
	const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/githive-votes/t1");
	const line = () => new GitCasLog<Line>(async () => remote(), "t1", lineRef("t1"));
	const policy = { required: 1, vetoes: [] };

	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-line-"));
		await startRepo(claims(), { baseline: server.git("rev-parse", "main").trim(), policy });
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	async function readyChange(change: string, files: Record<string, string>) {
		await claim(claims(), { change, agent: `agent-${change}`, paths: Object.keys(files), intent: change });
		const head = await pushChange(server.url, work, `agent-${change}`, change, files);
		await vote(votes(), { commit: head, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
		return head;
	}

	/**
	 * Checks through the line record. A check fails when a change in `failing`
	 * is in what it ran (itself, or one ahead merged in first), as real checks
	 * would; a failing one finishes only once `behind` checks have started, so
 * the ones behind it are checked after it, and fail first.
	 */
	function runner(failing = new Set<string>(), seen: { change: string; base: string; ahead: string[] }[] = [], behind = 0): CheckRunner {
		return lineCheckRunner({
			log: line(),
			main: () => branchHead(remote(), "main"),
			check: async ({ change, base, ahead }) => {
				seen.push({ change, base, ahead: ahead.map((a) => a.change) });
				// A failing one finishes last: after the checks behind it have started (or 5 s), however slow the machine.
				if (failing.has(change)) for (const until = Date.now() + 5_000; seen.length < behind && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 20));
				await new Promise((resolve) => setTimeout(resolve, 20));
				const broken = [change, ...ahead.map((a) => a.change)].some((c) => failing.has(c));
				return { passed: !broken, results: [{ command: "npm test", exitCode: broken ? 1 : 0, output: "" }] };
			},
			pollMs: 50,
		});
	}

	const merge = (change: string, runChecks: CheckRunner) =>
		mergeChange({
			remote: remote(),
			branch: "main",
			store: claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() }),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			verify: ["npm test"],
			runChecks,
			change,
			agent: `agent-${change}`,
		});

	const auditNow = async () => {
		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/githive-claims/t1");
		const merges = await readMainMerges(remote(), registry[0].state.baseline!, "main");
		return audit({ registry, votes: await readRecordHistory<Votes>(remote(), "refs/notes/githive-votes/t1"), policy, verify: ["npm test"], merges });
	};

	it("lands merges checked side by side in line order, each on exactly what it was tested on, and audits clean", async () => {
		for (const x of ["a", "b", "c"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const seen: { change: string; base: string; ahead: string[] }[] = [];
		const runChecks = runner(new Set(), seen);
		const outcomes = await Promise.all(["a-1", "b-1", "c-1"].map((c) => merge(c, runChecks)));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		// Checked once each, no retries.
		expect(seen.length).toBe(3);
		expect(await auditNow()).toEqual([]);
		const done = (await line().read())!.commit.state;
		expect(done.entries).toEqual([]);
		expect(done.left.map((l) => l.how)).toEqual(["landed", "landed", "landed"]);
		expect(done.tip).toBe(server.git("rev-parse", "main").trim());
	});

	it("checks the merges behind a failure again without it, lands them, and audits clean", async () => {
		for (const x of ["a", "b", "c"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const seen: { change: string; base: string; ahead: string[] }[] = [];
		const runChecks = runner(new Set(["a-1"]), seen, 3);
		// a joins first and fails. b and c, checked after it, fail too, before a has: they wait to see
		// whose failure it is, and once a fails they check again without it.
		const a = merge("a-1", runChecks);
		while (!(await line().read())?.commit.state.entries.length) await new Promise((resolve) => setTimeout(resolve, 10));
		const [outA, outB, outC] = await Promise.all([a, merge("b-1", runChecks), merge("c-1", runChecks)]);
		expect(outA).toMatchObject({ ok: false });
		expect(outB).toMatchObject({ ok: true });
		expect(outC).toMatchObject({ ok: true });
		expect(server.git("log", "--first-parent", "--format=%(trailers:key=GitHive-Change,valueonly)", "main").trim().split("\n").filter(Boolean).sort()).toEqual(["b-1", "c-1"]);
		// b was checked once after a, then again without it.
		expect(seen.filter((r) => r.change === "b-1").map((r) => r.ahead.includes("a-1"))).toEqual([true, false]);
		expect(await auditNow()).toEqual([]);
	});
});

describe("the audit of merges checked in line", () => {
	const merge = (commit: string, base: string, head: string, extra: Partial<MergeRecord> = {}): MergeRecord => ({ commit, author: "a", change: commit, claimsTip: "r1", head, votesTip: "v1", base, files: [], ...extra });
	const records = (merges: MergeRecord[]) => ({ registry: [{ tip: "r1", state: { claims: [], released: [] } }], verify: ["npm test"], merges });

	it("accepts a merge landing right after exactly the merges it was tested after", async () => {
		const merges = [merge("m1", "m0", "ha", { testedOn: "m0" }), merge("m2", "m1", "hb", { testedOn: "m0", testedAfter: ["ha"] })];
		expect((await audit(records(merges))).filter((v) => v.rule === "untested")).toEqual([]);
	});

	it("reports a merge that landed after something it wasn't tested with", async () => {
		const merges = [merge("m1", "m0", "hx", { testedOn: "m0" }), merge("m2", "m1", "hb", { testedOn: "m0", testedAfter: ["ha"] }), merge("m3", "m2", "hc", { testedOn: "m0" })];
		const untested = (await audit(records(merges))).filter((v) => v.rule === "untested").map((v) => v.commit);
		expect(untested).toEqual(["m2", "m3"]);
	});
});
