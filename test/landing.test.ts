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
import { type Landing, memoryLanding } from "../src/toolkit/landing";
import { batchSize, type Candidate, CHECKS_REVIEWER, type CheckRunner, mergeChange } from "../src/toolkit/merge";
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
	function runner(failing = new Set<string>(), runs: string[][] = [], flaky?: string): CheckRunner {
		let flaked = false;
		return async ({ changes }) => {
			runs.push(changes.map((c) => c.change));
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

	const merge = (change: string, runChecks: CheckRunner, landing: Landing = memoryLanding()) =>
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
		});

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
		expect(await merge("a-1", runner(new Set(["b-1"]), runs))).toMatchObject({ ok: true });
		expect(landed().sort()).toEqual(["a-1", "c-1", "d-1"]);
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
