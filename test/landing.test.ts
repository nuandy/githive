import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clef, ClefQuestion } from "../src/clef";
import { statusOf } from "../src/errors";
import { GitCasLog } from "../src/record-log";
import { branchHead } from "../src/git";
import { audit, type MergeRecord } from "../src/toolkit/audit";
import { claimStore } from "../src/toolkit/claim-store";
import { claim, startRepo, type Registry } from "../src/toolkit/claims";
import { readMainMerges, readRecordHistory } from "../src/toolkit/git-records";
import { type Landing, memoryLanding, renewLease } from "../src/toolkit/landing";
import {
	type BatchGit,
	batchSize,
	type Candidate,
	CHECKS_REVIEWER,
	type CheckRunner,
	type MergeInput,
	mergeChange,
} from "../src/toolkit/merge";
import { voteStore } from "../src/toolkit/vote-store";
import { vote, type Votes } from "../src/toolkit/votes";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";
import { gitHistory } from "./helpers/git-history";
import { artifactsInspect } from "../src/toolkit/batch-reads";
import { forgetChains } from "../src/toolkit/batch-reads";

// Landing as a set: the lease holder checks every ready change together on main and lands them in one push, each as
// its own merge. A failing batch is split until the failing change is found and put out with the checks' rejection,
// as is a change that doesn't merge while the batch lands. The audit checks that each batch landed exactly as it was
// checked.

describe("landing ready changes together", { timeout: 120_000 }, () => {
	let server: GitServer;
	let work: string;
	const remote = () => ({ url: server.url, token: "unused" });
	const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/githive-claims/t1");
	const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/githive-votes/t1");
	const store = () => claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() });
	const policy = { required: 1, vetoes: [] };

	beforeEach(async () => {
		forgetChains();
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

	/** Checks that fail when a change in `failing` runs (and once for `flaky`), slowly enough for merges to meet. */
	function runner(
		failing = new Set<string>(),
		runs: string[][] = [],
		flaky?: string,
		gates: string[] = [],
	): CheckRunner {
		let flaked = false;
		return async ({ changes, gate }) => {
			runs.push(changes.map((c) => c.change));
			gates.push(gate ?? "");
			await new Promise((resolve) => setTimeout(resolve, 50));
			const flake = !!flaky && !flaked && changes.some((c) => c.change === flaky);
			flaked ||= flake;
			const broken = flake || changes.some((c) => failing.has(c.change));
			return {
				passed: !broken,
				results: [{ command: "npm test", exitCode: broken ? 1 : 0, output: broken ? "1 failing" : "" }],
			};
		};
	}

	/** The other changes into main as the toolkit finds them: claims in force, with their heads. */
	const others = async (): Promise<Candidate[]> => {
		const { claims: held } = await store().read();
		return Promise.all(
			held.map(async (c) => ({
				claim: c,
				head: await branchHead(remote(), `changes/${c.change}`).catch(() => null),
				source: async () => remote(),
			})),
		);
	};

	const merge = (
		change: string,
		runChecks: CheckRunner,
		landing: Landing = memoryLanding(),
		more: Partial<MergeInput> = {},
	) =>
		mergeChange({
			remote: remote(),
			batchGit: memoryBatchGit(remote()),
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

	const auditNow = async (verify = ["npm test"]) => {
		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/githive-claims/t1");
		const merges = await readMainMerges(remote(), registry[0]!.state.baseline!, "main");
		return audit({
			registry,
			votes: await readRecordHistory<Votes>(remote(), "refs/notes/githive-votes/t1"),
			policy,
			verify,
			merges,
		});
	};
	const checksRejections = async () =>
		((await votes().read())?.commit.state.votes ?? []).filter((v) => v.reviewer === CHECKS_REVIEWER);
	const landed = () =>
		server
			.git("log", "--first-parent", "--format=%(trailers:key=GitHive-Change,valueonly)", "main")
			.trim()
			.split("\n")
			.filter(Boolean)
			.reverse();

	it("tells why each change was made in its merge commit: its intent, and who approved it", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		expect(await merge("a-1", runner())).toMatchObject({ ok: true });
		expect(server.git("log", "-1", "--format=%s", "main").trim()).toBe("a-1");
		expect(server.git("log", "-1", "--format=%b", "main")).toContain("- rev (tests): ok");
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Intent,valueonly)", "main").trim()).toBe("a-1");
		expect(await auditNow()).toEqual([]);
	});

	it("lands all ready changes in one checked batch, each its own merge in one push, and audits clean", async () => {
		const heads = [];
		for (const x of ["a", "b", "c"]) heads.push(await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` }));
		const main = server.git("rev-parse", "main").trim();
		const runs: string[][] = [];
		expect(await merge("a-1", runner(new Set(), runs))).toMatchObject({ ok: true });
		expect(runs).toEqual([["a-1", "b-1", "c-1"]]);
		expect(landed()).toEqual(["a-1", "b-1", "c-1"]);
		// Each says the main the checks ran on and every change checked with it.
		expect(
			server
				.git("log", "-3", "--first-parent", "--format=%(trailers:key=GitHive-Tested,valueonly)", "main")
				.trim()
				.split("\n")
				.filter(Boolean),
		).toEqual([main, main, main]);
		expect(server.git("log", "-1", "--format=%(trailers:key=GitHive-Tested-With,valueonly)", "main").trim()).toBe(
			heads.join(" "),
		);
		// Their claims are released, naming their merges.
		expect((await store().read()).claims).toEqual([]);
		expect(await auditNow()).toEqual([]);
	});

	it("lands in another's batch a change whose reviewer rejected and then approved its head", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const head = await readyChange("b-1", { "src/b.txt": "b\n" });
		const again = { commit: head, reviewer: "rev2", role: "tests" } as const;
		await vote(votes(), { ...again, verdict: "reject", evidence: "no test" });
		await vote(votes(), { ...again, verdict: "approve", evidence: "the test is there" });
		expect(await merge("a-1", runner())).toMatchObject({ ok: true });
		expect(landed().sort()).toEqual(["a-1", "b-1"]);
	});

	it("reads a batch through Artifacts' API, and lands it in the Gate, which reads nothing", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const reads: string[][] = [];
		const gate = readsNoted(reads);
		expect(
			await merge("a-1", runner(), memoryLanding(), {
				batchGit: { ...gate, inspect: artifactsInspect(gitHistory(server.git), "project", gate.inspect) },
			}),
		).toMatchObject({ ok: true });
		expect(reads).toEqual([]);
		expect(landed()).toEqual(["a-1", "b-1"]);
		expect(await auditNow()).toEqual([]);
	});

	it("starts the repo's Gate as each batch begins, while it's read, so the landing finds it running", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const started: string[] = [];
		const reads: string[][] = [];
		const gate = readsNoted(reads);
		const noted: BatchGit = { ...gate, inspect: async (input) => (started.push("read"), gate.inspect(input)) };
		expect(
			await merge("a-1", runner(), memoryLanding(), {
				batchGit: noted,
				prepareLanding: async () => void started.push("gate"),
			}),
		).toMatchObject({ ok: true });
		expect(started.slice(0, 2)).toEqual(["gate", "read"]);
		expect(landed()).toEqual(["a-1", "b-1"]);
	});

	it("records a change main already has (its push applied, though it failed) as landed, then the rest", async () => {
		const a = await readyChange("a-1", { "src/a.txt": "a\n" });
		// a-1 lands on main behind GitHive's back, like a push that applied despite a 500. Its claim is still held.
		const lander = await agentClone(server.url, work, "lander");
		await lander.run("fetch", "--quiet", "origin", "changes/a-1");
		await lander.run("merge", "--quiet", "--no-ff", "-m", "a-1, pushed though the server failed it", "FETCH_HEAD");
		await lander.run("push", "--quiet", "origin", "main");
		const mergedAs = server.git("rev-parse", "main").trim();
		await readyChange("b-1", { "src/b.txt": "b\n" });
		const landing = memoryLanding();
		expect(await merge("b-1", runner(), landing, { history: gitHistory(server.git) })).toMatchObject({ ok: true });
		expect(landed()).toContain("b-1");
		expect((await landing.view()).recent).toEqual(
			expect.arrayContaining([expect.objectContaining({ change: "a-1", head: a, how: "landed", commit: mergedAs })]),
		);
		// Its claim is released, naming the merge that took it in.
		expect((await store().read()).claims.map((c) => c.change)).not.toContain("a-1");
	});

	it("puts out the change whose checks fail, with the checks' rejection on its head, and lands the rest", async () => {
		const heads: Record<string, string> = {};
		for (const x of ["a", "b", "c", "d"]) heads[x] = await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const runs: string[][] = [];
		const gates: string[] = [];
		const landing = memoryLanding();
		expect(await merge("a-1", runner(new Set(["b-1"]), runs, undefined, gates), landing)).toMatchObject({ ok: true });
		expect(landed().sort()).toEqual(["a-1", "c-1", "d-1"]);
		// The passing half landed before the search found the failure. This merge's own change, in the other half,
		// waited for the next batch.
		expect((await landing.view()).recent.map((s) => [s.change, s.how])).toEqual([
			["c-1", "landed"],
			["d-1", "landed"],
			["b-1", "failed"],
			["a-1", "landed"],
		]);
		// The search reused the batch's own containers: a half stays where its batch ran, the other takes one more.
		const first = runs.findIndex((r) => r.length === 4);
		const search = gates[first]!.replace(/-0$/, "");
		const where = (changes: string[]) => gates.filter((_, i) => runs[i]!.join() === changes.join());
		expect(where(["a-1", "b-1", "c-1", "d-1"])).toEqual([`${search}-0`]);
		expect(where(["a-1", "b-1"])).toEqual([`${search}-0`]);
		expect(where(["c-1", "d-1"])).toEqual([`${search}-1`]);
		expect(where(["b-1"])).toEqual([`${search}-2`, `${search}-2`]);
		// b was checked alone twice (a failing run isn't trusted once) before it was put out.
		expect(runs.filter((r) => r.length === 1 && r[0] === "b-1").length).toBe(2);
		const rejected = (await votes().read())!.commit.state.votes.filter((v) => v.reviewer === CHECKS_REVIEWER);
		expect(rejected).toMatchObject([{ commit: heads.b, role: "checks", verdict: "reject" }]);
		expect(rejected[0]!.evidence).toContain("checks failed: npm test exited 1");
		expect((await store().read()).claims.map((c) => c.change)).toEqual(["b-1"]);
		expect(await auditNow()).toEqual([]);
		// Merging that commit again is refused at once, with the failure: it isn't checked a third time.
		const before = runs.length;
		const again = await merge("b-1", runner(new Set(["b-1"]), runs));
		expect(again).toMatchObject({
			ok: false,
			reasons: [expect.stringMatching(/^checks failed: npm test exited 1 on .* push a fix \(a new commit\)/)],
			// What failed, read back from the rejection, so what follows needn't be read from the reason.
			why: ["checks"],
			checks: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
		});
		expect(runs.length).toBe(before);
	});

	it("releases a landed half's claims though the other half's checks then throw", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const checks = runner(new Set(["b-1"]));
		let thrown = false;
		// The half holding the failure throws once, after the other half has passed and begun landing.
		const throwing: CheckRunner = async (input) => {
			const half = input.changes.map((c) => c.change).join();
			if (thrown || half !== "a-1,b-1") return checks(input);
			thrown = true;
			await new Promise((resolve) => setTimeout(resolve, 300));
			throw new Error("the check container didn't answer");
		};
		await merge("a-1", throwing).catch(() => undefined);
		expect(thrown).toBe(true);
		expect(landed()).toEqual(expect.arrayContaining(["c-1", "d-1"]));
		// Their paths are free at once: their claims went with their landing, not 30 minutes later.
		const held = (await store().read()).claims.map((c) => c.change);
		expect(held).not.toContain("c-1");
		expect(held).not.toContain("d-1");
	});

	it("asks Clef which change failed a batch, keeps its guess beside what the search found, and searches the same", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const asked: { state: string; questions: Record<string, ClefQuestion> }[] = [];
		const clef: Clef = {
			ask: async (_model, state, questions) => {
				asked.push({ state, questions });
				const suspect = questions.suspect as Extract<ClefQuestion, { type: "choice" }>;
				const b = Object.entries(suspect.criteria).find(([, text]) => text.startsWith("b-1"))![0];
				return {
					environment: { type: "noul", noul: 0.12 },
					suspect: { type: "choice", choice: b, probabilities: { [b]: 0.64 }, confidence: 0.5 },
				};
			},
		};
		const runs: string[][] = [];
		const landing = memoryLanding();
		expect(await merge("a-1", runner(new Set(["b-1"]), runs), landing, { clef })).toMatchObject({ ok: true });
		expect(asked).toHaveLength(1);
		expect(asked[0]!.state).toBe("$ npm test (exited 1)\n1 failing");
		const failed = (await landing.view()).recent.find((settled) => settled.how === "failed");
		expect(failed).toMatchObject({ change: "b-1", environment: 0.12, suspect: { change: "b-1", likelihood: 0.64 } });
		// The search is the one without Clef: halves, then b alone twice.
		expect(runs.map((run) => run.length)).toEqual([4, 2, 2, 1, 1, 1, 1]);
	});

	it("tells a change's merge that Clef thinks the environment failed its checks", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const clef: Clef = {
			ask: async (_model, state, questions) => {
				expect(questions).not.toHaveProperty("suspect");
				return { environment: { type: "noul", noul: /ECONNRESET/.test(state) ? 0.93 : 0.1 } };
			},
		};
		const failing: CheckRunner = async () => ({
			passed: false,
			results: [{ command: "npm test", exitCode: 1, output: "npm ERR! network ECONNRESET" }],
		});
		const landing = memoryLanding();
		expect(await merge("a-1", failing, landing, { clef })).toMatchObject({
			ok: false,
			why: ["checks"],
			environment: 0.93,
		});
		expect((await landing.view()).recent).toMatchObject([{ change: "a-1", how: "failed", environment: 0.93 }]);
		expect((await landing.view()).recent[0]).not.toHaveProperty("suspect");
	});

	it("puts out no change when the checks couldn't run, and lands them once they can", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const runs: string[][] = [];
		let broken = 3;
		const flakyGate: CheckRunner = async ({ changes }) => {
			runs.push(changes.map((c) => c.change));
			if (broken-- > 0) {
				const results = [{ command: "(gate setup)", exitCode: 1, output: "fetching the project failed" }];
				return { passed: false, results, setupFailed: true };
			}
			return { passed: true, results: [] };
		};
		expect(await merge("a-1", flakyGate)).toMatchObject({ ok: true });
		expect(await checksRejections()).toEqual([]);
		expect(landed().sort()).toEqual(["a-1", "b-1"]);
		// Each failed setup was the whole batch's, never split to blame one change.
		expect(runs.slice(0, 3)).toEqual([
			["a-1", "b-1"],
			["a-1", "b-1"],
			["a-1", "b-1"],
		]);
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

	it("without checks, batches every ready change and releases their claims once the lease is handed on", async () => {
		const ids = Array.from({ length: 6 }, (_, i) => `n-${i}`);
		for (const id of ids) await readyChange(id, { [`src/${id}.txt`]: `${id}\n` });
		const landing = memoryLanding();
		// Checks failed often here lately, so with checks a batch would hold 4 (see batchSize).
		await landing.settle(
			Array.from({ length: 10 }, (_, i) => ({
				change: `old-${i}`,
				head: `h${i}`,
				agent: "x",
				how: "failed" as const,
				at: new Date().toISOString(),
			})),
		);
		expect(batchSize((await landing.view()).recent)).toBe(4);
		const reads: string[][] = [];
		// The lease should be handed on first, then the claims released.
		const order: string[] = [];
		const drop = landing.drop.bind(landing);
		landing.drop = async (holder) => (order.push("lease handed on"), drop(holder));
		const claimStore = store();
		const release = claimStore.release.bind(claimStore);
		claimStore.release = async (r, stamper) => (order.push(`released ${r.change}`), release(r, stamper));
		expect(
			await merge("n-0", runner(), landing, {
				verify: [],
				runChecks: undefined,
				batchGit: readsNoted(reads),
				store: claimStore,
			}),
		).toMatchObject({ ok: true });
		// Without checks, one batch of all 6.
		expect(reads).toEqual([ids]);
		expect(landed()).toEqual(ids);
		expect(order[0]).toBe("lease handed on");
		expect(order.slice(1).sort()).toEqual(ids.map((id) => `released ${id}`).sort());
		expect((await store().read()).claims).toEqual([]);
	});

	it("builds a batch on main as it is now, not as kept a moment for the crowd asking", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const before = server.git("rev-parse", "main").trim();
		const landing = memoryLanding();
		const reads: string[][] = [];
		expect(await merge("a-1", runner(), landing, { maxBatch: 1, batchGit: readsNoted(reads) })).toMatchObject({
			ok: true,
		});
		// A cached head from before a-1 landed. A batch built on it would be refused at its push.
		expect(
			await merge("b-1", runner(), landing, { batchGit: readsNoted(reads), branchHead: async () => before }),
		).toMatchObject({ ok: true });
		expect(reads).toEqual([["a-1"], ["b-1"]]);
		expect(landed()).toEqual(["a-1", "b-1"]);
	});

	it("leaves a change that landed out of the next batch while its claim isn't released yet", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const reads: string[][] = [];
		// a-1's batch lands, but its claim isn't released yet.
		const claimStore = store();
		claimStore.release = async () => ({ ok: true }) as never;
		expect(
			await merge("a-1", runner(), landing, { maxBatch: 1, batchGit: readsNoted(reads), store: claimStore }),
		).toMatchObject({ ok: true });
		expect((await store().read()).claims.map((c) => c.change)).toEqual(["a-1", "b-1"]);
		// b-1's batch doesn't take a-1 up again.
		expect(await merge("b-1", runner(), landing, { batchGit: readsNoted(reads) })).toMatchObject({ ok: true });
		expect(reads).toEqual([["a-1"], ["b-1"]]);
		expect(landed()).toEqual(["a-1", "b-1"]);
	});

	it("names who last changed each file a merge conflicts on: their change, agent, intent and commit", async () => {
		const landing = memoryLanding();
		const before = server.git("rev-parse", "main").trim();
		await readyChange("a-1", { "src/shared.txt": "from a\n" });
		const landedA = await merge("a-1", runner(), landing);
		expect(landedA).toMatchObject({ ok: true });
		// Then someone pushed to main with plain git, in the same file.
		const pusher = await agentClone(server.url, work, "pusher");
		pusher.write("src/shared.txt", "from a, and the pusher\n");
		await pusher.run("commit", "-qam", "touch up shared");
		await pusher.run("push", "-q", "origin", "main");
		const pushed = server.git("rev-parse", "main").trim();
		// b-1 started from the main before a-1 landed, and changed the same file.
		const refused = await (async () => {
			await claim(claims(), { change: "b-1", agent: "agent-b-1", paths: ["src/shared.txt"], intent: "b-1" });
			const head = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/shared.txt": "from b\n" }, before);
			await vote(votes(), { commit: head, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
			return merge("b-1", runner(), landing, { history: gitHistory(server.git) });
		})();
		const aCommit = (landedA as { commit: string }).commit;
		expect(refused).toMatchObject({
			ok: false,
			conflicts: ["src/shared.txt"],
			// The landing's recent outcomes know only what GitHive landed.
			causes: [{ file: "src/shared.txt", change: "a-1", agent: "agent-a-1", intent: "a-1", commit: aCommit }],
			// The branch's history knows the plain push too, newest first.
			touchedBy: [
				{ file: "src/shared.txt", commit: pushed, author: "pusher", intent: "touch up shared" },
				{ file: "src/shared.txt", commit: aCommit, change: "a-1", agent: "agent-a-1", intent: "a-1" },
			],
			hunks: [
				{ file: "src/shared.txt", content: expect.stringContaining("<<<<<<< ours (changes/b-1)\n"), truncated: false },
			],
			fix: expect.arrayContaining(["git add -u && git commit --no-edit", "git push fork changes/b-1"]),
		});
		expect((refused as { reasons: string[] }).reasons[0]).toMatch(
			/src\/shared\.txt \(changed by a-1, agent-a-1: "a-1", [0-9a-f]{8}\).*see touchedBy, hunks and fix$/,
		);
	});

	/** A plain-git push to main that adds src/shared.txt, as someone working outside GitHive might. Returns main. */
	async function pushSharedToMain() {
		const pusher = await agentClone(server.url, work, "pusher");
		pusher.write("src/shared.txt", "from main\n");
		await pusher.run("add", "-A");
		await pusher.run("commit", "-qm", "add shared on main");
		await pusher.run("push", "-q", "origin", "main");
		return server.git("rev-parse", "main").trim();
	}

	it("puts out a change that conflicts with main while landing, naming its files, and lands the rest", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const cHead = await readyChange("c-1", { "src/shared.txt": "from c\n" });
		const noted: string[][] = [];
		const noteAttempt = async (change: string, line: string) => void noted.push([change, line]);
		// No checks, so nothing but the landing finds the conflict.
		const more = { verify: [], runChecks: undefined, history: gitHistory(server.git), noteAttempt };
		// c-1 passes its own test merge, then waits while another merge holds the lease.
		const landing = memoryLanding();
		let cWaits!: () => void;
		const waiting = new Promise<void>((resolve) => (cWaits = resolve));
		const watched: Landing = {
			...landing,
			turn: async (holder, change, ...rest) => {
				if (change === "c-1") cWaits();
				return landing.turn(holder, change, ...rest);
			},
		};
		await landing.turn("someone", "x-1", "x", Date.now(), 60_000);
		const c = merge("c-1", runner(), watched, more);
		await waiting;
		// Meanwhile main gets c-1's file, pushed with plain git.
		const pushed = await pushSharedToMain();
		const a = merge("a-1", runner(), watched, more);
		await landing.drop("someone");
		const [cOutcome, aOutcome] = await Promise.all([c, a]);

		// The batch of three landed the two that merge. c-1 is refused for this round, naming the conflict's files and
		// how to resolve it, as a change failing its checks would be. Nothing more is read while the lease is held.
		expect(aOutcome).toMatchObject({ ok: true });
		expect(landed().sort()).toEqual(["a-1", "b-1"]);
		const reason = "conflict on src/shared.txt";
		expect(cOutcome).toEqual({
			ok: false,
			why: ["conflict"],
			into: "main",
			head: cHead,
			conflicts: ["src/shared.txt"],
			fix: [
				"git fetch origin main && git merge origin/main",
				"# resolve src/shared.txt so both changes make sense, then:",
				"git add -u && git commit --no-edit",
				"git push fork changes/c-1",
				"call status; once the new commit is approved, merge again",
			],
			reasons: [reason],
		});
		expect(noted).toEqual([["c-1", reason]]);
		// The checks' rejection of its head keeps it out of later batches until it has a new commit, and its claim stays.
		const rejected = (await votes().read())!.commit.state.votes.filter((v) => v.reviewer === CHECKS_REVIEWER);
		expect(rejected).toMatchObject([{ commit: cHead, role: "checks", verdict: "reject" }]);
		expect(rejected[0]!.evidence).toBe(`${reason} on ${cHead.slice(0, 8)}, found while landing it on main`);
		expect((await store().read()).claims.map((claim) => claim.change)).toEqual(["c-1"]);
		// Merging that commit again is refused at once, explained by its own test merge: who changed the file, its
		// markers and its fix.
		expect(await merge("c-1", runner(), landing, more)).toMatchObject({
			ok: false,
			why: ["conflict"],
			into: "main",
			conflicts: ["src/shared.txt"],
			touchedBy: [{ file: "src/shared.txt", commit: pushed, author: "pusher", intent: "add shared on main" }],
			hunks: [{ file: "src/shared.txt", content: expect.stringContaining("<<<<<<< ours (changes/c-1)\n") }],
			fix: expect.arrayContaining(["git add -u && git commit --no-edit"]),
		});
	});

	it("puts out a change whose merge failed though git listed no files, test-merging nothing while landing", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const cHead = await readyChange("c-1", { "src/shared.txt": "from c\n" });
		const pushed = await pushSharedToMain();
		const git = memoryBatchGit(remote());
		// As the Gate says a merge that failed without listing its files: the change, and no files.
		const unlisted: BatchGit = {
			...git,
			land: async (input) => {
				const landed = await git.land(input);
				if (typeof landed !== "object" || !("failed" in landed) || !landed.conflict) return landed;
				return { failed: landed.failed, conflict: { change: landed.conflict.change, files: [] } };
			},
		};
		const landing = memoryLanding();
		const more = { verify: [], runChecks: undefined, batchGit: unlisted, history: gitHistory(server.git) };
		expect(await merge("a-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(landed()).toEqual(["a-1"]);
		const putOut = (await landing.view()).recent.find((settled) => settled.change === "c-1");
		expect(putOut).toMatchObject({
			how: "failed",
			head: cHead,
			conflicts: [],
			reasons: ["conflict on files git didn't list"],
		});
		expect(putOut).not.toHaveProperty("touchedBy");
		// Only the plain push is reported: what landed names no change put out.
		expect((await auditNow([])).filter((violation) => violation.commit !== pushed)).toEqual([]);
		// The change's own merge names the files, and who changed them, from a test merge of its own.
		expect(await merge("c-1", runner(), landing, more)).toMatchObject({
			ok: false,
			why: ["conflict"],
			conflicts: ["src/shared.txt"],
			touchedBy: [{ file: "src/shared.txt", commit: pushed, author: "pusher", intent: "add shared on main" }],
		});
	});

	it("fails the landing as before, test-merging nothing, when it failed for anything but a merge", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		// c-1 conflicts with main alone, but the push failed, which says nothing of a conflict: nobody is put out.
		await readyChange("c-1", { "src/shared.txt": "from c\n" });
		await pushSharedToMain();
		const failing: BatchGit = { ...memoryBatchGit(remote()), land: async () => ({ failed: "the push failed: boom" }) };
		const landing = memoryLanding();
		const more = { verify: [], runChecks: undefined, batchGit: failing };
		const failed = await merge("a-1", runner(), landing, more).catch((err: unknown) => err);
		expect(statusOf(failed)).toMatchObject({ status: 500, message: "landing the batch failed: the push failed: boom" });
		expect(landed()).toEqual([]);
		expect(await checksRejections()).toEqual([]);
		expect((await landing.view()).recent).toEqual([]);
	});

	it("takes git's word that the change it named didn't merge, without test-merging it under the lease", async () => {
		const aHead = await readyChange("a-1", { "src/a.txt": "a\n" });
		const failing: BatchGit = {
			...memoryBatchGit(remote()),
			land: async () => ({ failed: "merging a-1 onto the batch failed: ?", conflict: { change: "a-1", files: [] } }),
		};
		const more = { verify: [], runChecks: undefined, batchGit: failing };
		expect(await merge("a-1", runner(), memoryLanding(), more)).toEqual({
			ok: false,
			why: ["conflict"],
			into: "main",
			head: aHead,
			fix: [
				"git fetch origin main && git merge origin/main",
				"# resolve the conflicts so both changes make sense, then:",
				"git add -u && git commit --no-edit",
				"git push fork changes/a-1",
				"call status; once the new commit is approved, merge again",
			],
			reasons: ["conflict on files git didn't list"],
		});
		expect((await checksRejections()).map((vote) => vote.commit)).toEqual([aHead]);
	});

	it("puts out each change in a batch that conflicts with main, a round each, and lands the rest", async () => {
		const aHead = await readyChange("a-1", { "src/a.txt": "from a\n" });
		await readyChange("b-1", { "src/b.txt": "b\n" });
		const cHead = await readyChange("c-1", { "src/c.txt": "from c\n" });
		// Someone adds both a-1's and c-1's files to main with plain git.
		const pusher = await agentClone(server.url, work, "pusher");
		pusher.write("src/a.txt", "from main\n");
		pusher.write("src/c.txt", "from main\n");
		await pusher.run("add", "-A");
		await pusher.run("commit", "-qm", "add a and c on main");
		await pusher.run("push", "-q", "origin", "main");
		const pushed = server.git("rev-parse", "main").trim();
		const tries: string[][] = [];
		const git = memoryBatchGit(remote());
		const noted: BatchGit = {
			...git,
			land: async (input) => (tries.push(input.merges.map((m) => m.change)), git.land(input)),
		};
		const landing = memoryLanding();
		const attemptsOf = vi.fn(async () => ({}));
		const more = { verify: [], runChecks: undefined, batchGit: noted, history: gitHistory(server.git), attemptsOf };
		expect(await merge("b-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(landed()).toEqual(["b-1"]);
		// Three rounds: each puts out the change that didn't merge, and lands the rest without it.
		expect(tries).toHaveLength(3);
		expect(tries.at(-1)).toEqual(["b-1"]);
		// The earlier attempts for the merge commits' story are read once for the batch, not once a round.
		expect(attemptsOf).toHaveBeenCalledOnce();
		const rejected = await checksRejections();
		expect(rejected.map((vote) => vote.commit).sort()).toEqual([aHead, cHead].sort());
		for (const vote of rejected)
			expect(vote.evidence).toMatch(/^conflict on src\/[ac]\.txt on [0-9a-f]{8}, found while landing it on main$/);
		expect((await landing.view()).recent.map((settled) => [settled.change, settled.how]).sort()).toEqual([
			["a-1", "failed"],
			["b-1", "landed"],
			["c-1", "failed"],
		]);
		// What landed names no change put out, so the audit reports only the plain push.
		expect((await auditNow([])).filter((violation) => violation.commit !== pushed)).toEqual([]);
		expect((await store().read()).claims.map((claim) => claim.change).sort()).toEqual(["a-1", "c-1"]);
	});

	it("lands nothing more once its lease is lost after a put-out: the merge takes its turn again", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		await readyChange("c-1", { "src/shared.txt": "from c\n" });
		await pushSharedToMain();
		const steps: string[] = [];
		let lose = false;
		const git = memoryBatchGit(remote());
		const noted: BatchGit = {
			...git,
			land: async (input) => {
				steps.push(`land ${input.merges.map((m) => m.change).join(",")}`);
				const landed = await git.land(input);
				if (typeof landed === "object" && "failed" in landed) lose = true;
				return landed;
			},
		};
		const landing = memoryLanding();
		// The lease is renewed once more after c-1 is put out, and that renewal is refused, as when another merge took it.
		const watched: Landing = {
			...landing,
			turn: async (...args) => (steps.push("turn"), landing.turn(...args)),
			renew: async (holder, ttl) => (lose ? ((lose = false), false) : landing.renew(holder, ttl)),
		};
		const more = { verify: [], runChecks: undefined, batchGit: noted };
		expect(await merge("a-1", runner(), watched, more)).toMatchObject({ ok: true });
		expect(landed()).toEqual(["a-1"]);
		// Not landed again in the same turn: the merge asked for its turn first.
		const [first, second] = steps.flatMap((step, i) => (step.startsWith("land") ? [i] : []));
		expect(steps.slice(first! + 1, second)).toContain("turn");
		expect(steps[second!]).toBe("land a-1");
	});

	it("puts out a change that conflicts while landing a checked batch, and checks the rest again without it", async () => {
		for (const x of ["a", "b", "c"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const git = memoryBatchGit(remote());
		let told = false;
		// The landing says once that c-1 doesn't merge, as though the checks had merged a batch the landing couldn't.
		const conflicting: BatchGit = {
			...git,
			land: async (input) => {
				if (told || !input.merges.some((merge) => merge.change === "c-1")) return git.land(input);
				told = true;
				return { failed: "merging c-1 onto the batch failed", conflict: { change: "c-1", files: ["src/c.txt"] } };
			},
		};
		const runs: string[][] = [];
		const landing = memoryLanding();
		expect(await merge("a-1", runner(new Set(), runs), landing, { batchGit: conflicting })).toMatchObject({ ok: true });
		expect(landed()).toEqual(["a-1", "b-1"]);
		// What was checked was checked with c-1, so the rest landed in the next batch, checked without it.
		expect(runs).toEqual([
			["a-1", "b-1", "c-1"],
			["a-1", "b-1"],
		]);
		expect((await landing.view()).recent.map((settled) => [settled.change, settled.how])).toEqual([
			["c-1", "failed"],
			["a-1", "landed"],
			["b-1", "landed"],
		]);
		// The batch that landed was checked without c-1, and its trailers say so: the audit is clean.
		expect(await auditNow()).toEqual([]);
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

	it("lands a change at the newest head it had approved when its batch is gathered", async () => {
		for (const x of ["a", "b", "c", "d"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const more = { maxBatch: 2 };
		expect(await merge("a-1", runner(), landing, more)).toMatchObject({ ok: true });
		// d pushes again, and its new commit is approved: the batch that takes it reads it now, at that commit.
		const newer = await pushChange(
			server.url,
			work,
			"agent-d-1",
			"d-1",
			{ "src/d.txt": "d, again\n" },
			"origin/changes/d-1",
		);
		await vote(votes(), { commit: newer, reviewer: "rev", role: "tests", verdict: "approve", evidence: "ok" });
		expect(await merge("c-1", runner(), landing, more)).toMatchObject({ ok: true });
		expect(
			server
				.git("log", "-1", "--format=%(trailers:key=GitHive-Tested-With,valueonly)", "main")
				.trim()
				.split(" ")
				.at(-1),
		).toBe(newer);
		expect(await auditNow()).toEqual([]);
	});

	it("answers a merge of a change that already landed with its commit, not that it holds no claim", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		const first = await merge("a-1", runner(), landing);
		expect(first).toMatchObject({ ok: true });
		expect(await merge("a-1", runner(), landing)).toEqual(first);
	});

	it("answers it from the branch's history when the landing can't recall it (its RepoCache unreachable)", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const first = await merge("a-1", runner(), memoryLanding());
		expect(first).toMatchObject({ ok: true });
		const forgetful: Landing = {
			...memoryLanding(),
			view: () => Promise.reject(new Error("Durable Object is overloaded")),
		};
		expect(await merge("a-1", runner(), forgetful, { history: gitHistory(server.git) })).toEqual({
			ok: true,
			commit: (first as { commit: string }).commit,
		});
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

	it("says a change is still waiting before the request is held too long, and lands it when merged again", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const landing = memoryLanding();
		// Another merge holds the lease, landing its batch, for longer than this merge may wait to answer.
		expect(await landing.turn("other", "x-1", "h", 0, 60_000)).toEqual({ lease: true });
		const runs: string[][] = [];
		const waiting = await mergeChange({
			remote: remote(),
			batchGit: memoryBatchGit(remote()),
			branch: "main",
			store: store(),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			verify: ["npm test"],
			runChecks: runner(new Set(), runs),
			change: "a-1",
			agent: "agent-a-1",
			landing,
			pollMs: 20,
			answerWithinMs: 300,
		});
		expect(waiting).toMatchObject({
			ok: false,
			pending: true,
			reasons: [expect.stringMatching(/^a-1 is ready and waiting to land .* Call merge again/)],
		});
		expect(runs).toEqual([]);
		// The other batch is done: merging again lands it.
		await landing.drop("other");
		expect(await merge("a-1", runner(new Set(), runs), landing)).toMatchObject({ ok: true });
		expect(landed()).toEqual(["a-1"]);
	});

	it("neither checks nor lands once its lease is another merge's: it waits its turn again", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const before = server.git("rev-parse", "main").trim();
		const runs: string[][] = [];
		// The lease is taken, then every renewal is refused: another merge has it now.
		const lost: Landing = { ...memoryLanding(), renew: async () => false };
		const answer = await merge("a-1", runner(new Set(), runs), lost, { heartbeatMs: 20, answerWithinMs: 300 });
		expect(answer).toMatchObject({ ok: false, pending: true });
		expect(runs).toEqual([]);
		expect(server.git("rev-parse", "main").trim()).toBe(before);
	});

	it("keeps the lease by heartbeat through a long check: a waiting merge doesn't take over and recheck", async () => {
		for (const x of ["a", "b"]) await readyChange(`${x}-1`, { [`src/${x}.txt`]: `${x}\n` });
		const landing = memoryLanding();
		const runs: string[][] = [];
		// Checks far longer than the lease lasts without a beat.
		const slow: CheckRunner = async (input) => (
			await new Promise((resolve) => setTimeout(resolve, 600)),
			runner(new Set(), runs)(input)
		);
		const go = (change: string) =>
			mergeChange({
				remote: remote(),
				batchGit: memoryBatchGit(remote()),
				branch: "main",
				store: store(),
				votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
				policy,
				verify: ["npm test"],
				runChecks: slow,
				change,
				agent: `agent-${change}`,
				others,
				landing,
				pollMs: 20,
				heartbeatMs: 50,
				leaseTtlMs: 150,
			});
		const [a, b] = await Promise.all([go("a-1"), go("b-1")]);
		expect(a).toMatchObject({ ok: true });
		expect(b).toMatchObject({ ok: true });
		// One batch, checked once: the waiting merge never took the lease from the one checking.
		expect(runs).toEqual([["a-1", "b-1"]]);
	});

	it("starts no batch once it should be answering: the lease goes to a merge that's waiting", async () => {
		await readyChange("a-1", { "src/a.txt": "a\n" });
		const runs: string[][] = [];
		const answer = await mergeChange({
			remote: remote(),
			batchGit: memoryBatchGit(remote()),
			branch: "main",
			store: store(),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			verify: ["npm test"],
			runChecks: runner(new Set(), runs),
			change: "a-1",
			agent: "agent-a-1",
			pollMs: 20,
			answerWithinMs: 0,
		});
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
	const merge = (commit: string, base: string, head: string, extra: Partial<MergeRecord> = {}): MergeRecord => ({
		commit,
		author: "a",
		change: commit,
		claimsTip: "r1",
		head,
		votesTip: "v1",
		base,
		files: [],
		...extra,
	});
	const records = (merges: MergeRecord[]) => ({
		registry: [{ tip: "r1", state: { claims: [], released: [] } }],
		verify: ["npm test"],
		merges,
	});
	const batch = { testedOn: "m0", testedWith: ["ha", "hb"] };

	it("accepts a batch that landed whole on the main it was checked on, in its order", async () => {
		const merges = [merge("m1", "m0", "ha", batch), merge("m2", "m1", "hb", batch)];
		expect((await audit(records(merges))).filter((v) => v.rule === "untested")).toEqual([]);
	});

	it("reports a batch that landed only in part, after something else, or out of order", async () => {
		const part = [merge("m1", "m0", "ha", batch)];
		const after = [
			merge("m1", "m0", "hx", { testedOn: "m0" }),
			merge("m2", "m1", "ha", batch),
			merge("m3", "m2", "hb", batch),
		];
		const swapped = [merge("m1", "m0", "hb", batch), merge("m2", "m1", "ha", batch)];
		for (const merges of [part, after, swapped]) {
			const untested = (await audit(records(merges))).filter((v) => v.rule === "untested").map((v) => v.commit);
			expect(untested).toEqual(merges.filter((m) => m.testedWith).map((m) => m.commit));
		}
	});
});

describe("the size of a batch", () => {
	const outcomes = (landed: number, failed: number) => [
		...Array(landed).fill({ how: "landed" }),
		...Array(failed).fill({ how: "failed" }),
	];

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
