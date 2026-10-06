import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog } from "../src/election-git";
import { branchHead } from "../src/git";
import { audit, type MergeRecord } from "../src/free/audit";
import { claimStore } from "../src/free/claim-store";
import { CheckLine, type LineRequest } from "../src/free/check-line";
import { claim, startFree, type Registry } from "../src/free/claims";
import { readMainMerges, readRecordHistory } from "../src/free/git-records";
import { type CheckRunner, mergeChange } from "../src/free/merge";
import { voteStore } from "../src/free/vote-store";
import { vote, type Votes } from "../src/free/votes";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The line merges wait in for checks (a merge queue): waiting merges are
// checked in batches, each on main with the merges ahead of it merged in
// first, side by side; each lands right after those, so main is always code
// that was tested, and the audit checks exactly that.

type Input = { label: string };
type Result = { passed: boolean; base: string; ahead: string[] };
const request = (change: string): LineRequest<Input> => ({ change, head: `${change}-head`, input: { label: change } });

/** A runner whose checks finish when told to, failing the changes in `failing`. */
function runner(failing = new Set<string>(), onRun?: (change: string) => void) {
	const runs: { lane: number; change: string; base: string; ahead: string[] }[] = [];
	let base = "m0";
	return {
		runs,
		setBase: (b: string) => void (base = b),
		run: {
			base: async () => base,
			check: async (lane: number, req: LineRequest<Input>, b: string, ahead: LineRequest<Input>[]) => {
				runs.push({ lane, change: req.change, base: b, ahead: ahead.map((a) => a.change) });
				onRun?.(req.change);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return { passed: !failing.has(req.change), base: b, ahead: ahead.map((a) => a.change) };
			},
		},
	};
}

describe("the line of merges", () => {
	it("checks a batch side by side, each after the ones ahead of it, and says what each lands after", async () => {
		const r = runner();
		const line = new CheckLine<Input, Result>(r.run, 4, 0);
		const [a, b, c] = await Promise.all(["a", "b", "c"].map((x) => line.join(request(x))));
		expect(r.runs).toEqual([
			{ lane: 0, change: "a", base: "m0", ahead: [] },
			{ lane: 1, change: "b", base: "m0", ahead: ["a"] },
			{ lane: 2, change: "c", base: "m0", ahead: ["a", "b"] },
		]);
		expect([a.after, b.after, c.after]).toEqual([[], [{ change: "a", head: "a-head" }], [{ change: "a", head: "a-head" }, { change: "b", head: "b-head" }]]);
		expect([a.base, b.base, c.base]).toEqual(["m0", "m0", "m0"]);
	});

	it("checks the merges behind a failure again without it, first in line", async () => {
		const r = runner(new Set(["b"]));
		const line = new CheckLine<Input, Result>(r.run, 4, 0);
		const results = await Promise.all(["a", "b", "c", "d"].map((x) => line.join(request(x))));
		expect(results.map((x) => x.result.passed)).toEqual([true, false, true, true]);
		// c and d ran again, after a only; their answers are from that run.
		expect(r.runs.slice(4)).toEqual([
			{ lane: 0, change: "c", base: "m0", ahead: [] },
			{ lane: 1, change: "d", base: "m0", ahead: ["c"] },
		]);
		expect(results[3].after).toEqual([{ change: "c", head: "c-head" }]);
	});

	it("takes at most one batch of lanes at a time; the rest wait for the next, on main as it is then", async () => {
		// Main moves while the first batch runs (its merges land).
		const r: ReturnType<typeof runner> = runner(new Set(), (change) => change === "b" && r.setBase("m2"));
		const line = new CheckLine<Input, Result>(r.run, 2, 0);
		await Promise.all(["a", "b", "c", "d", "e"].map((x) => line.join(request(x))));
		expect(r.runs.map((x) => [x.lane, x.change, x.base])).toEqual([
			[0, "a", "m0"],
			[1, "b", "m0"],
			[0, "c", "m2"],
			[1, "d", "m2"],
			[0, "e", "m2"],
		]);
	});

	it("lets a change's newer head replace its place while it waits", async () => {
		const r = runner();
		const line = new CheckLine<Input, Result>(r.run, 1, 0);
		const busy = line.join(request("a"));
		const old = line.join({ ...request("b"), head: "b-old" });
		const fresh = line.join({ ...request("b"), head: "b-new" });
		await expect(old).rejects.toThrow(/joined the line again/);
		await busy;
		expect((await fresh).result.passed).toBe(true);
		expect(r.runs.map((x) => x.change)).toEqual(["a", "b"]);
	});
});

describe("merging in line", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	const remote = () => ({ url: server.url, token: "unused" });
	const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/blueprint-claims/t1");
	const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/blueprint-votes/t1");
	const policy = { required: 1, vetoes: [] };

	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "blueprint-line-"));
		await startFree(claims(), { baseline: server.git("rev-parse", "main").trim(), policy });
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

	/** A check runner through a real line; checks pass, and the base is main as it is when a batch starts. */
	function lineRunner(lanes = 4): CheckRunner {
		const line = new CheckLine<{ change: string }, { passed: boolean }>(
			{ base: async () => (await branchHead(remote(), "main"))!, check: async () => ({ passed: true }) },
			lanes,
			3_000,
		);
		return async ({ change, head }) => {
			const { base, after } = await line.join({ change, head, input: { change } });
			return { passed: true, results: [{ command: "npm test", exitCode: 0, output: "ok" }], base, after };
		};
	}

	const merge = (change: string, runChecks: CheckRunner, turnWaitMs?: number) =>
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
			...(turnWaitMs ? { turnWaitMs } : {}),
		});

	const auditNow = async () => {
		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/blueprint-claims/t1");
		const merges = await readMainMerges(remote(), registry[0].state.baseline!, "main");
		return audit({ registry, votes: await readRecordHistory<Votes>(remote(), "refs/notes/blueprint-votes/t1"), policy, verify: ["npm test"], merges });
	};

	it("lands merges checked side by side in line order, each on exactly what it was tested on, and audits clean", async () => {
		const heads = [];
		for (const x of ["a", "b", "c"]) heads.push(await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` }));
		const runChecks = lineRunner();
		const outcomes = await Promise.all(["a-1", "b-1", "c-1"].map((c) => merge(c, runChecks)));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		// One check run each, no retries: three merges on main, each after the ones ahead of it.
		const after = server.git("log", "--first-parent", "-3", "--format=%(trailers:key=Blueprint-Tested-After,valueonly)", "main").trim().split("\n").filter(Boolean);
		expect(after.length).toBe(2);
		expect(await auditNow()).toEqual([]);
	});

	it("checks again, without it, when a merge ahead in line never lands", async () => {
		const aHead = await readyChange("a-1", { "src/a.txt": "a\n" });
		await readyChange("b-1", { "src/b.txt": "b\n" });
		const main = server.git("rev-parse", "main").trim();
		// b was checked after a, but a's merge never comes.
		let calls = 0;
		const runChecks: CheckRunner = vi.fn(async () => {
			calls++;
			return calls === 1
				? { passed: true, results: [], base: main, after: [{ change: "a-1", head: aHead }] }
				: { passed: true, results: [], base: server.git("rev-parse", "main").trim(), after: [] };
		});
		expect(await merge("b-1", runChecks, 50)).toMatchObject({ ok: true });
		expect(calls).toBe(2);
		expect(server.git("log", "-1", "--format=%(trailers:key=Blueprint-Tested-After,valueonly)", "main").trim()).toBe("");
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
