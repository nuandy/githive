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
import { type Landing, memoryLanding, renewLease } from "../src/toolkit/landing";
import { type BatchGit, batchSize, type Candidate, CHECKS_REVIEWER, type CheckRunner, type MergeInput, memoryBatchGit, mergeChange } from "../src/toolkit/merge";
import { voteStore } from "../src/toolkit/vote-store";
import { vote, type Votes } from "../src/toolkit/votes";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Landing without a line: claims keep changes off each other's paths, so the
// ready ones (approved) land as a set. The merge that takes the branch's lease
// checks every ready change together on main, once, and lands them in one
// push, each as its own merge; a failing batch is split until the change that
// fails is found, and that one is put out with the checks' rejection on its
// head. The audit checks that each batch landed exactly as it was checked.

describe("landing ready changes together", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	const remote = () => ({ url: server.url, token: "unused" });
	const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/githive-claims/t1");
	const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/githive-votes/t1");
	const store = () => claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() });
	const policy = { required: 1, vetoes: [] };

	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-landing-"));
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

	/** Checks that fail when a change in `failing` is among what they ran (and, once, when `flaky` is), slowly enough for merges to meet. */
	function runner(failing = new Set<string>(), runs: string[][] = [], flaky?: string, gates: string[] = []): CheckRunner {
		let flaked = false;
		return async ({ changes, gate }) => {
			runs.push(changes.map((c) => c.change));
			gates.push(gate ?? "");
			await new Promise((resolve) => setTimeout(resolve, 50));
			const flake = !!flaky && !flaked && changes.some((c) => c.change === flaky);
			flaked ||= flake;
			const broken = flake || changes.some((c) => failing.has(c.change));
			return { passed: !broken, results: [{ command: "npm test", exitCode: broken ? 1 : 0, output: broken ? "1 failing" : "" }] };
		};
	}

	/** The other changes into main, as the toolkit finds them: claims in force, with their heads (in the project repo here). */
	const others = async (): Promise<Candidate[]> => {
		const { claims: held } = await store().read();
		return Promise.all(held.map(async (c) => ({ claim: c, head: await branchHead(remote(), `changes/${c.change}`).catch(() => null), source: async () => remote() })));
	};

	const merge = (change: string, runChecks: CheckRunner, landing: Landing = memoryLanding(), more: Partial<MergeInput> = {}) =>
		mergeChange({
			remote: remote(),
			branch: "main",
			store: store(),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			verify: ["npm test"],
			runChecks,
			change,
			agent: `agent-${change}`,
			others,
			landing,
			pollMs: 20,
			...more,
		});

	/** The batch's git work in memory, noting which changes each read was of. */
	const readsNoted = (reads: string[][]): BatchGit => {
		const git = memoryBatchGit(remote());
		return { ...git, inspect: async (input) => (reads.push(input.changes.map((c) => c.change)), git.inspect(input)) };
	};

	const auditNow = async () => {
		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/githive-claims/t1");
		const merges = await readMainMerges(remote(), registry[0].state.baseline!, "main");
		return audit({ registry, votes: await readRecordHistory<Votes>(remote(), "refs/notes/githive-votes/t1"), policy, verify: ["npm test"], merges });
	};
	const landed = () => server.git("log", "--first-parent", "--format=%(trailers:key=GitHive-Change,valueonly)", "main").trim().split("\n").filter(Boolean).reverse();

	it("lands every ready change in one batch, checked once, each as its own merge in one push, and audits clean", async () => {
		const heads = [];
		for (const x of ["a", "b", "c"]) heads.push(await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` }));
		const main = server.git("rev-parse", "main").trim();
		const runs: string[][] = [];
		expect(await merge("a-1", runner(new Set(), runs))).toMatchObject({ ok: true });
		expect(runs).toEqual([["a-1", "b-1", "c-1"]]);
		expect(landed()).toEqual(["a-1", "b-1", "c-1"]);
		// Each says the main the checks ran on and every change checked with it.
		expect(server.git("log", "-3", "--first-parent", "--format=%(trailers:key=GitHive-Tested,valueonly)", "main").trim().split("\n").filter(Boolean)).toEqual([main, main, main]);
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Tested-With,valueonly)", "main").trim()).toBe(heads.join(" "));
		// Their claims are released, naming their merges.
		expect((await store().read()).claims).toEqual([]);
		expect(await auditNow()).toEqual([]);
	});

	it("puts out the change whose checks fail, with the checks' rejection on its head, and lands the rest", async () => {
		const heads: Record<string, string> = {};
		for (const x of ["a", "b", "c", "d"]) heads[x] = await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const runs: string[][] = [];
		const gates: string[] = [];
		const landing = memoryLanding();
		expect(await merge("a-1", runner(new Set(["b-1"]), runs, undefined, gates), landing)).toMatchObject({ ok: true });
		expect(landed().sort()).toEqual(["a-1", "c-1", "d-1"]);
		// The half found passing landed at once, before the search had found what failed; this merge's own change, in the
		// other half, waited for the next batch.
		expect((await landing.view()).recent.map((s) => [s.change, s.how])).toEqual([
			["c-1", "landed"],
			["d-1", "landed"],
			["b-1", "failed"],
			["a-1", "landed"],
		]);
		// The search reused the batch's own containers: a half stays where its batch ran, the other takes one more.
		const first = runs.findIndex((r) => r.length === 4);
		const search = gates[first].replace(/-0$/, "");
		const where = (changes: string[]) => gates.filter((_, i) => runs[i].join() === changes.join());
		expect(where(["a-1", "b-1", "c-1", "d-1"])).toEqual([`${search}-0`]);
		expect(where(["a-1", "b-1"])).toEqual([`${search}-0`]);
		expect(where(["c-1", "d-1"])).toEqual([`${search}-1`]);
		expect(where(["b-1"])).toEqual([`${search}-2`, `${search}-2`]);
		// b was checked alone twice (a failing run isn't trusted once) before it was put out.
		expect(runs.filter((r) => r.length === 1 && r[0] === "b-1").length).toBe(2);
		const rejected = (await votes().read())!.commit.state.votes.filter((v) => v.reviewer === CHECKS_REVIEWER);
		expect(rejected).toMatchObject([{ commit: heads.b, role: "checks", verdict: "reject" }]);
		expect(rejected[0].evidence).toContain("checks failed: npm test exited 1");
		expect((await store().read()).claims.map((c) => c.change)).toEqual(["b-1"]);
		expect(await auditNow()).toEqual([]);
		// Merging that commit again is refused at once, with the failure: it isn't checked a third time.
		const before = runs.length;
		const again = await merge("b-1", runner(new Set(["b-1"]), runs));
		expect(again).toMatchObject({ ok: false, reasons: [expect.stringMatching(/^checks failed: npm test exited 1 on .* push a fix \(a new commit\)/)] });
		expect(runs.length).toBe(before);
	});

	it("checks a lone failure once more: a flaky run doesn't put a change out", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const runs: string[][] = [];
		expect(await merge("a-1", runner(new Set(), runs, "a-1"))).toMatchObject({ ok: true });
		expect(runs).toEqual([["a-1"], ["a-1"]]);
	});

	it("tells a merge waiting on another's batch what its change came to, without checking it again", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const runs: string[][] = [];
		const checks = runner(new Set(), runs);
		const [a, b] = await Promise.all([merge("a-1", checks, landing), merge("b-1", checks, landing)]);
		expect(a).toMatchObject({ ok: true });
		expect(b).toMatchObject({ ok: true });
		expect(runs).toEqual([["a-1", "b-1"]]);
		expect((await landing.view()).recent.map((s) => [s.change, s.how])).toEqual([
			["a-1", "landed"],
			["b-1", "landed"],
		]);
		expect(await auditNow()).toEqual([]);
	});

	it("reads the next batch while one is checked, and the merge that lands it reads none of it again", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const reads: string[][] = [];
		const runs: string[][] = [];
		const more = { maxBatch: 2, batchGit: readsNoted(reads) };
		expect(await merge("a-1", runner(new Set(), runs), landing, more)).toMatchObject({ ok: true });
		// Its own batch, then the next one, read while its own was checked.
		expect(reads).toEqual([
			["a-1", "b-1"],
			["c-1", "d-1"],
		]);
		expect((await landing.ahead())?.read.map((r) => r.change)).toEqual(["c-1", "d-1"]);
		// The next merge lands what was read ahead, on the main the first batch left, without reading it again.
		expect(await merge("c-1", runner(new Set(), runs), landing, more)).toMatchObject({ ok: true });
		expect(reads.length).toBe(2);
		expect(runs).toEqual([
			["a-1", "b-1"],
			["c-1", "d-1"],
		]);
		expect(landed()).toEqual(["a-1", "b-1", "c-1", "d-1"]);
		expect(await auditNow()).toEqual([]);
	});

	it("without checks, reads the next batch once this one is pushed, and the merge that lands it reads none of it again", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		// What the repo's Gate is asked to do, in order: it does one thing at a time, so reading the next batch first would hold up the push.
		const asked: string[] = [];
		const git = memoryBatchGit(remote());
		const batchGit: BatchGit = {
			inspect: async (input) => (asked.push(`read ${input.changes.map((c) => c.change)}`), git.inspect(input)),
			land: async (input) => (asked.push(`land ${input.merges.map((m) => m.change)}`), git.land(input)),
		};
		const more = { maxBatch: 2, batchGit, verify: [], runChecks: undefined };
		expect(await merge("a-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(asked).toEqual(["read a-1,b-1", "land a-1,b-1", "read c-1,d-1"]);
		expect(await merge("c-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(asked.slice(3)).toEqual(["land c-1,d-1"]);
		expect(landed()).toEqual(["a-1", "b-1", "c-1", "d-1"]);
	});

	it("tells the merges waiting on a batch that it landed before their claims are released", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const claimStore = store();
		const release = claimStore.release.bind(claimStore);
		const heard: string[] = [];
		claimStore.release = async (r, stamper) => {
			if ((await landing.view()).recent.some((s) => s.change === r.change && s.how === "landed")) heard.push(r.change);
			return release(r, stamper);
		};
		expect(await merge("a-1", runner(), landing, { store: claimStore })).toMatchObject({ ok: true });
		expect(heard).toEqual(["a-1", "b-1"]);
		expect((await store().read()).claims).toEqual([]);
		expect(await auditNow()).toEqual([]);
	});

	it("reads a change again when it has a new head since it was read ahead", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const reads: string[][] = [];
		const more = { maxBatch: 2, batchGit: readsNoted(reads) };
		expect(await merge("a-1", runner(), landing, more)).toMatchObject({ ok: true });
		// d pushes again, and its new commit is approved: what was read ahead of it is out of date.
		const newer = await pushChange(server.url, work, "agent-d-1", "d-1", { "src/d.txt": "d, again\n" }, "origin/changes/d-1");
		await vote(votes(), { commit: newer, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
		expect(await merge("c-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(reads.slice(2)).toEqual([["d-1"]]);
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Tested-With,valueonly)", "main").trim().split(" ").at(-1)).toBe(newer);
		expect(await auditNow()).toEqual([]);
	});

	it("answers a merge of a change that already landed with its commit, not that it holds no claim", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		const first = await merge("a-1", runner(), landing);
		expect(first).toMatchObject({ ok: true });
		expect(await merge("a-1", runner(), landing)).toEqual(first);
	});

	it("waits for as long as another merge holds the lease, and takes it over once it runs out", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		// Another merge took the lease, and went quiet: it isn't renewed.
		expect(await landing.turn("gone", "x-1", "h", 0, 300)).toEqual({ lease: true });
		const from = Date.now();
		expect(await merge("a-1", runner(), landing)).toMatchObject({ ok: true });
		expect(Date.now() - from).toBeGreaterThanOrEqual(250);
	});

	it("answers that a change is still waiting before the request is held too long, and lands it when merged again", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		// Another merge holds the lease, landing its batch, for longer than this merge may wait to answer.
		expect(await landing.turn("other", "x-1", "h", 0, 60_000)).toEqual({ lease: true });
		const runs: string[][] = [];
		const waiting = await mergeChange({ remote: remote(), branch: "main", store: store(), votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }), policy, verify: ["npm test"], runChecks: runner(new Set(), runs), change: "a-1", agent: "agent-a-1", landing, pollMs: 20, answerWithinMs: 300 });
		expect(waiting).toMatchObject({ ok: false, pending: true, reasons: [expect.stringMatching(/^a-1 is ready and waiting to land .* Call merge again/)] });
		expect(runs).toEqual([]);
		// The other batch is done: merging again lands it.
		await landing.drop("other");
		expect(await merge("a-1", runner(new Set(), runs), landing)).toMatchObject({ ok: true });
		expect(landed()).toEqual(["a-1"]);
	});

	it("doesn't check again what passed on the same main, in the same order (a merge that took over a dropped one's batch)", async () => {
		const head = await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		await landing.checked(server.git("rev-parse", "main").trim(), [head]);
		const runs: string[][] = [];
		expect(await merge("a-1", runner(new Set(), runs), landing)).toMatchObject({ ok: true });
		expect(runs).toEqual([]);
		expect(landed()).toEqual(["a-1"]);
	});

	it("keeps the lease by a heartbeat through a long check: a merge waiting doesn't take over and check again", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const runs: string[][] = [];
		// Checks far longer than the lease lasts without a beat.
		const slow: CheckRunner = async (input) => (await new Promise((resolve) => setTimeout(resolve, 600)), runner(new Set(), runs)(input));
		const go = (change: string) =>
			mergeChange({ remote: remote(), branch: "main", store: store(), votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }), policy, verify: ["npm test"], runChecks: slow, change, agent: `agent-${change}`, others, landing, pollMs: 20, heartbeatMs: 50, leaseTtlMs: 150 });
		const [a, b] = await Promise.all([go("a-1"), go("b-1")]);
		expect(a).toMatchObject({ ok: true });
		expect(b).toMatchObject({ ok: true });
		// One batch, checked once: the waiting merge never took the lease from the one checking.
		expect(runs).toEqual([["a-1", "b-1"]]);
	});

	it("starts no batch once it should be answering: the lease goes to a merge that's waiting", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const runs: string[][] = [];
		const answer = await mergeChange({ remote: remote(), branch: "main", store: store(), votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }), policy, verify: ["npm test"], runChecks: runner(new Set(), runs), change: "a-1", agent: "agent-a-1", pollMs: 20, answerWithinMs: 0 });
		expect(answer).toMatchObject({ ok: false, pending: true });
		expect(runs).toEqual([]);
	});

	it("leaves out a change that isn't approved, and a change sent back, and lands only what's ready", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		await claim(claims(), { change: "b-1", agent: "agent-b-1", paths: ["src/b.txt"], intent: "b" });
		await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const cHead = await readyChange("c-1", { "src/c.txt": "c\n" });
		await vote(votes(), { commit: cHead, reviewer: "rev2", role: "tests", verdict: "reject", evidence: "not yet" });
		const runs: string[][] = [];
		expect(await merge("a-1", runner(new Set(), runs))).toMatchObject({ ok: true });
		expect(runs).toEqual([["a-1"]]);
		expect(landed()).toEqual(["a-1"]);
	});
});

describe("the audit of changes checked together", () => {
	const merge = (commit: string, base: string, head: string, extra: Partial<MergeRecord> = {}): MergeRecord => ({ commit, author: "a", change: commit, claimsTip: "r1", head, votesTip: "v1", base, files: [], ...extra });
	const records = (merges: MergeRecord[]) => ({ registry: [{ tip: "r1", state: { claims: [], released: [] } }], verify: ["npm test"], merges });
	const batch = { testedOn: "m0", testedWith: ["ha", "hb"] };

	it("accepts a batch that landed whole on the main it was checked on, in its order", async () => {
		const merges = [merge("m1", "m0", "ha", batch), merge("m2", "m1", "hb", batch)];
		expect((await audit(records(merges))).filter((v) => v.rule === "untested")).toEqual([]);
	});

	it("reports a batch that landed only in part, after something else, or out of order", async () => {
		const part = [merge("m1", "m0", "ha", batch)];
		const after = [merge("m1", "m0", "hx", { testedOn: "m0" }), merge("m2", "m1", "ha", batch), merge("m3", "m2", "hb", batch)];
		const swapped = [merge("m1", "m0", "hb", batch), merge("m2", "m1", "ha", batch)];
		for (const merges of [part, after, swapped]) {
			const untested = (await audit(records(merges))).filter((v) => v.rule === "untested").map((v) => v.commit);
			expect(untested).toEqual(merges.filter((m) => m.testedWith).map((m) => m.commit));
		}
	});
});

describe("the size of a batch", () => {
	const outcomes = (landed: number, failed: number) => [...Array(landed).fill({ how: "landed" }), ...Array(failed).fill({ how: "failed" })];

	it("is about one failure per batch, from what the branch's recent changes came to", () => {
		// A new branch: the prior, 1 in 20.
		expect(batchSize([])).toBe(20);
		// 1 in 40 failing (with the prior, 3 in 80).
		expect(batchSize(outcomes(58, 2))).toBe(27);
	});

	it("grows to its most on a branch where nothing fails, and shrinks to its least on a flaky one", () => {
		expect(batchSize(outcomes(200, 0))).toBe(64);
		expect(batchSize(outcomes(10, 10))).toBe(4);
	});
});

describe("the branch's lease", () => {
	it("is kept as long as the longest step running needs, never shortened by a shorter one", () => {
		const held = { checking: null, recent: [], lease: { holder: "m", until: 1_000 + 50 * 60_000 } };
		// A landing's step (5 minutes) while a check (50) runs alongside it.
		expect(renewLease(held, "m", 5 * 60_000, 1_000).state.lease).toEqual({ holder: "m", until: 1_000 + 50 * 60_000 });
		expect(renewLease(held, "m", 60 * 60_000, 1_000).state.lease).toEqual({ holder: "m", until: 1_000 + 60 * 60_000 });
		expect(renewLease(held, "other", 60_000, 1_000).held).toBe(false);
	});
});
