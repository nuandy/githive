import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import { claimStore } from "../src/toolkit/claim-store";
import { audit } from "../src/toolkit/audit";
import { claim, startRepo, type Registry } from "../src/toolkit/claims";
import { readMainMerges, readRecordHistory } from "../src/toolkit/git-records";
import { mergeChange } from "../src/toolkit/merge";
import { generateStampKey, makeStamper, type Stamper } from "../src/toolkit/stamp";
import { vote, type Votes } from "../src/toolkit/votes";
import { voteStore } from "../src/toolkit/vote-store";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";
import { agentClone, pushChange } from "./helpers/agents";

// GitHive end to end, on a real Git server. Cooperative agents
// claim, review and merge by convention through the toolkit; a rogue agent
// merges by hand with plain git, breaking the conventions and claiming in its
// trailers that it didn't. Nothing stopped it; the audit, reading only Git,
// reports what it did.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });
const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/githive-claims/t1");
const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/githive-votes/t1");
const policy = { required: 2, vetoes: ["security"], grants: { security: ["service:rev-2"] } };
// Each agent acts through the toolkit as itself, as Access verified it.
let as: Record<"a" | "b" | "c" | "rev1" | "rev2", Stamper>;

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-"));
	const key = await generateStampKey();
	const stamper = (name: string) => makeStamper(key.privateKey, `service:${name}`);
	as = {
		a: await stamper("agent-a"),
		b: await stamper("agent-b"),
		c: await stamper("agent-c"),
		rev1: await stamper("rev-1"),
		rev2: await stamper("rev-2"),
	};
	await startRepo(claims(), { baseline: server.git("rev-parse", "main").trim(), policy, stampKey: key.publicKey });
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("GitHive, end to end", { timeout: 60_000 }, () => {
	it("lets cooperative agents merge by convention, and the audit catches a rogue that didn't", async () => {
		// Agent a: claims, pushes, gets two approvals, merges through the toolkit.
		await claim(claims(), { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" }, as.a);
		const aHead = await pushChange(server.url, work, "agent-a", "a-1", { "src/a/x.txt": "a\n" });
		await vote(
			votes(),
			{ commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" },
			as.rev1,
		);
		await vote(
			votes(),
			{ commit: aHead, reviewer: "rev-2", role: "security", verdict: "approve", evidence: "ok" },
			as.rev2,
		);
		const merged = await mergeChange({
			remote: remote(),
			batchGit: memoryBatchGit(remote()),
			branch: "main",
			store: claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() }),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			stamper: as.a,
			stampKey: (await claims().read())!.commit.state.stampKey,
			change: "a-1",
			agent: "agent-a",
		});
		expect(merged).toMatchObject({ ok: true });

		// Agent c holds src/c/.
		await claim(claims(), { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "c's work" }, as.c);

		// Agent b claims src/b/, but also edits inside c's claim, gets one approval
		// of two, and merges by hand with trailers citing real tips.
		await claim(claims(), { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b's work" }, as.b);
		const bHead = await pushChange(server.url, work, "agent-b", "b-1", {
			"src/b/y.txt": "b\n",
			"src/c/z.txt": "not b's\n",
		});
		await vote(
			votes(),
			{ commit: bHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" },
			as.rev1,
		);
		const rogue = await agentClone(server.url, work, "agent-b-rogue");
		await rogue.run("fetch", "--quiet", "origin", "changes/b-1");
		const claimsTip = (await claims().read())!.tip;
		const votesTip = (await votes().read())!.tip;
		await rogue.run(
			"merge",
			"--quiet",
			"--no-ff",
			"FETCH_HEAD",
			"-m",
			`Merge b-1\n\nGitHive-Change: b-1\nGitHive-Agent: agent-b\nGitHive-Claims: ${claimsTip}\nGitHive-Votes: ${votesTip}`,
		);
		await rogue.run("push", "--quiet", "origin", "main");
		const bMerge = await rogue.run("rev-parse", "HEAD");
		// And a "hotfix" straight to main, declaring nothing.
		rogue.write("README.md", "hotfix\n");
		await rogue.run("add", "README.md");
		await rogue.run("commit", "--quiet", "-m", "hotfix");
		await rogue.run("push", "--quiet", "origin", "main");
		const hotfix = await rogue.run("rev-parse", "HEAD");

		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/githive-claims/t1");
		const records = {
			registry,
			votes: await readRecordHistory<Votes>(remote(), "refs/notes/githive-votes/t1"),
			policy,
			merges: await readMainMerges(remote(), registry[0]!.state.baseline!, "main"),
		};
		expect(records.merges.map((m) => m.change ?? "(none)")).toEqual(["a-1", "b-1", "(none)"]);
		expect(await audit(records)).toEqual([
			{
				commit: bMerge,
				author: "agent-b",
				rule: "unverified",
				detail: "the merge has no valid GitHive stamp: whoever made it, and what its trailers say, is unverified",
			},
			{
				commit: bMerge,
				author: "agent-b",
				rule: "inside-another-claim",
				detail: `src/c/z.txt was claimed by c-1 (agent-c) at ${claimsTip}`,
			},
			{ commit: bMerge, author: "agent-b", rule: "unapproved", detail: `${bHead} had 1 of 2 approvals at ${votesTip}` },
			{
				commit: hotfix,
				author: "agent-b-rogue",
				rule: "undeclared",
				detail: "the merge names no change or claims it checked (GitHive-Change, GitHive-Claims)",
			},
		]);
	});

	it("refuses, in the toolkit, to merge a change that breaks a convention", async () => {
		await claim(claims(), { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" }, as.a);
		const aHead = await pushChange(server.url, work, "agent-a", "a-1", {
			"src/a/x.txt": "a\n",
			"src/elsewhere.txt": "outside\n",
		});
		await vote(votes(), { commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const outcome = await mergeChange({
			remote: remote(),
			batchGit: memoryBatchGit(remote()),
			branch: "main",
			store: claimStore({ repo: "t1", registry: undefined, root: claims(), remote: async () => remote() }),
			votes: voteStore({ repo: "t1", root: votes(), remote: async () => remote() }),
			policy,
			change: "a-1",
			agent: "agent-a",
		});
		expect(outcome).toEqual({
			ok: false,
			reasons: ["src/elsewhere.txt is outside a-1's claim", `${aHead} has 1 of 2 approvals`],
			why: ["outside", "approvals"],
			outsideClaim: ["src/elsewhere.txt"],
		});
		expect(server.git("rev-list", "--count", "main").trim()).toBe("1");
	});
});
