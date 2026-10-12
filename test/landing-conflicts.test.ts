import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_MERGE } from "../src/toolkit/merge-checks";
import { agentClone, pushChange } from "./helpers/agents";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";

// A conflict found while landing, in the Gate's checks or its landing (a tree landing hands such a batch over), comes
// back naming the change and its files. The checks name who changed each since the change left the branch, read
// Worker-side from the branch's history through Artifacts' API (played here by git). The landing hands the conflict
// to the merge, which puts the change out (see land in merge-land.ts) and names who changed them the same way.

let server: GitServer;
let work: string;

// Artifacts, played by the test server: the project is its repo "project", every fork its repo "fork".
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, name: string, scope: string) => ({
		url: name.startsWith("fork--") ? server.repo("fork") : server.url,
		token: scope,
	})),
	withHistory: vi.fn(async (_artifacts: unknown, name: string, read: (source: never) => Promise<unknown>) =>
		gitHistory(name === "fork" ? (...args) => server.gitIn("fork", ...args) : server.git)(name, read as never),
	),
}));

const { toolContextFor } = await import("../src/toolkit/env");

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-landing-conflicts-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/**
 * b-1 in agent-b's fork, started from main before a-1 landed there; both changed shared.txt. Returns main before and
 * after, and b-1's head.
 */
async function conflicting() {
	const before = server.git("rev-parse", "main").trim();
	const seed = await agentClone(server.url, work, "seed");
	await seed.run("push", "--quiet", server.repo("fork"), "main");
	const head = await pushChange(server.repo("fork"), work, "agent-b", "b-1", { "shared.txt": "b\n" });
	seed.write("shared.txt", "a\n");
	await seed.run("add", "shared.txt");
	const trailers = "GitHive-Change: a-1\nGitHive-Intent: add shared\nGitHive-Agent: agent-a";
	await seed.run("commit", "-q", "-m", "add shared", "-m", trailers);
	await seed.run("push", "--quiet", "origin", "main");
	return { before, main: server.git("rev-parse", "main").trim(), head };
}

/** An Env whose Gate answers `gate` and whose RepoCache notes attempts in `noted`. */
function envWith(gate: Record<string, unknown>, noted: string[][]) {
	return {
		ARTIFACTS: {},
		GATE: { getByName: () => gate },
		REPO_CACHE: {
			getByName: () => ({ noteAttempt: async (change: string, line: string) => void noted.push([change, line]) }),
		},
	} as unknown as Env;
}

describe("a conflict found while landing", { timeout: 60_000 }, () => {
	it("names the files and who changed them when the Gate's checks can't merge a change alone", async () => {
		const { main, head } = await conflicting();
		const env = envWith(
			{
				checkCommit: async () => ({ passed: false, head, baseHead: main, mergeConflict: ["shared.txt"], results: [] }),
			},
			[],
		);
		const runChecks = toolContextFor(env, "service:t").runChecks!("lc1");
		const change = { change: "b-1", head, ref: "changes/b-1", agent: "agent-b" };
		const checked = await runChecks({ base: main, branch: "main", changes: [change], commands: ["npm test"] });
		const touchedBy = [{ file: "shared.txt", commit: main, change: "a-1", agent: "agent-a", intent: "add shared" }];
		expect(checked).toEqual({
			passed: false,
			results: [
				{
					command: BATCH_MERGE,
					exitCode: 1,
					output: `conflict on shared.txt with a-1 by agent-a ("add shared", ${main.slice(0, 7)})`,
				},
			],
			conflict: { files: ["shared.txt"], touchedBy },
		});
		// In a batch of several, the conflict may be with another change in it, so only the files are named.
		const other = { change: "c-1", head, ref: "changes/c-1", agent: "agent-c" };
		const batch = await runChecks({ base: main, branch: "main", changes: [other, change], commands: ["npm test"] });
		expect(batch.results[0]).toEqual({ command: BATCH_MERGE, exitCode: 1, output: "conflict on shared.txt" });
		expect(batch.conflict).toEqual({ files: ["shared.txt"] });
	});

	it("hands the change and its files back when a tree landing hands the batch to the Gate and it doesn't merge", async () => {
		const { main, head } = await conflicting();
		const noted: string[][] = [];
		const env = envWith(
			{
				landBatch: async () => ({
					error: "merging b-1 onto the batch failed: shared.txt\nCONFLICT (add/add)",
					conflict: { change: "b-1", files: ["shared.txt"] },
				}),
			},
			noted,
		);
		const land = toolContextFor(env, "service:t").batchGit!("lc2").land;
		const merge = {
			change: "b-1",
			head,
			ref: "changes/b-1",
			agent: "agent-b",
			source: { url: server.repo("fork"), token: "read" },
			claimed: { head, change: "b-1", author: "agent-b", claimsTip: "c1", votesTip: "v1" },
		};
		expect(await land({ base: main, branch: "main", merges: [merge] })).toEqual({
			failed: "merging b-1 onto the batch failed: shared.txt\nCONFLICT (add/add)",
			conflict: { change: "b-1", files: ["shared.txt"] },
		});
		// The merge notes the attempt when it puts the change out.
		expect(noted).toEqual([]);
	});
});

describe("a change put out for a conflict", () => {
	it("is told with the files it was found with, reading nothing more while the lease is held", async () => {
		const { putOut } = await import("../src/toolkit/merge-checks");
		const history = vi.fn();
		const input = {
			branch: "main",
			remote: { url: "https://artifacts.invalid/p.git", token: "t" },
			history,
			votes: { vote: async () => undefined },
		} as unknown as import("../src/toolkit/merge-types").MergeInput;
		const ready = { change: "c-1", head: "c".repeat(40), agent: "agent-c", ref: "changes/c-1" } as never;
		const settled = await putOut(input, ready, { results: [], conflict: { files: ["src/a.ts"] } }, "checked alone");
		expect(settled).toMatchObject({ how: "failed", reasons: ["conflict on src/a.ts"], conflicts: ["src/a.ts"] });
		expect(settled).not.toHaveProperty("touchedBy");
		expect(history).not.toHaveBeenCalled();
	});
});

describe("a conflict on hundreds of files", () => {
	it("names a few of them and how many more, so its rejection and its outcome stay small", async () => {
		const { putOut } = await import("../src/toolkit/merge-checks");
		const files = Array.from({ length: 600 }, (_, i) => `src/generated/part-${i}.ts`);
		const touchedBy = files.map((file) => ({
			file,
			commit: "f".repeat(40),
			author: "fmt-bot",
			intent: "x".repeat(140),
		}));
		const voted: { evidence: string }[] = [];
		const noted: string[] = [];
		const input = {
			branch: "main",
			remote: { url: "https://artifacts.invalid/p.git", token: "t" },
			votes: { vote: async (vote: { evidence: string }) => void voted.push(vote) },
			noteAttempt: async (_change: string, line: string) => void noted.push(line),
		} as unknown as import("../src/toolkit/merge-types").MergeInput;
		const ready = { change: "c-1", head: "c".repeat(40), agent: "agent-c", ref: "changes/c-1" } as never;
		const failure = { results: [], conflict: { files, touchedBy } };
		const settled = await putOut(input, ready, failure, "found while landing it on main");
		const [reason] = settled.reasons!;
		expect(reason).toMatch(/^conflict on src\/generated\/part-0\.ts with f{7} by fmt-bot \("x{140}"\); /);
		expect(reason).toMatch(/; and 59\d more files$/);
		expect(reason!.length).toBeLessThanOrEqual(1_200);
		expect(voted[0]!.evidence.length).toBeLessThanOrEqual(2_000);
		expect(voted[0]!.evidence).toBe(`${reason} on ${"c".repeat(8)}, found while landing it on main`);
		expect(noted).toEqual([reason]);
		// Failed checks keep the end of their output in what's left of the 2,000, however long the command.
		const checks = { results: [{ command: `npm test ${"z".repeat(3_000)}`, exitCode: 1, output: "y".repeat(10_000) }] };
		await putOut(input, ready, checks, "checked alone on the branch, twice");
		expect(voted[1]!.evidence.length).toBeLessThanOrEqual(2_000);
		expect(voted[1]!.evidence).not.toContain("y".repeat(10_000));
		// The outcome keeps the first 50 files, not 600.
		expect(settled.conflicts).toHaveLength(50);
		expect(JSON.stringify(settled).length).toBeLessThan(8_000);
	});
});
