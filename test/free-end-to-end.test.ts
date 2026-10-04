import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { audit } from "../src/free/audit";
import { claim, startFree, type Registry } from "../src/free/claims";
import { readMainMerges, readRecordHistory } from "../src/free/git-records";
import { mergeChange } from "../src/free/merge";
import { generateStampKey, makeStamper, type Stamper } from "../src/free/stamp";
import { vote, type Votes } from "../src/free/votes";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Coordinator-free mode end to end, on a real Git server. Cooperative agents
// claim, review and merge by convention through the toolkit; a rogue agent
// merges by hand with plain git, breaking the conventions and claiming in its
// trailers that it didn't. Nothing stopped it; the audit, reading only Git,
// reports what it did.

let server: GitServer;
let work: string;
const remote = () => ({ url: server.url, token: "unused" });
const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/blueprint-claims/t1");
const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/blueprint-votes/t1");
const policy = { required: 2, vetoes: ["security"] };
// Each agent acts through the toolkit as itself, as Access verified it.
let as: Record<"a" | "b" | "c" | "rev1" | "rev2", Stamper>;

// The Git server runs in this process: git must run asynchronously, or the
// server can't answer it.
const exec = promisify(execFile);

/** An agent's own clone, driven with plain git. */
async function agentClone(name: string) {
	const dir = join(work, name);
	await exec("git", ["clone", "--quiet", server.url, dir]);
	const run = async (...args: string[]) => (await exec("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@example.com`, ...args])).stdout.trim();
	const write = (path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	return { run, write };
}

/** Push a change branch with the given files, and return its head. */
async function pushChange(agent: string, change: string, files: Record<string, string>) {
	const clone = await agentClone(`${agent}-${change}`);
	await clone.run("checkout", "--quiet", "-b", `changes/${change}`);
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", `${change}: work`);
	await clone.run("push", "--quiet", "origin", `changes/${change}`);
	return clone.run("rev-parse", "HEAD");
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "blueprint-free-"));
	const key = await generateStampKey();
	const stamper = (name: string) => makeStamper(key.privateKey, `service:${name}`);
	as = { a: await stamper("agent-a"), b: await stamper("agent-b"), c: await stamper("agent-c"), rev1: await stamper("rev-1"), rev2: await stamper("rev-2") };
	await startFree(claims(), { baseline: server.git("rev-parse", "main").trim(), policy, stampKey: key.publicKey });
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("coordinator-free mode, end to end", { timeout: 60_000 }, () => {
	it("lets cooperative agents merge by convention, and the audit catches a rogue that didn't", async () => {
		// Agent a: claims, pushes, gets two approvals, merges through the toolkit.
		await claim(claims(), { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" }, as.a);
		const aHead = await pushChange("agent-a", "a-1", { "src/a/x.txt": "a\n" });
		await vote(votes(), { commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" }, as.rev1);
		await vote(votes(), { commit: aHead, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "ok" }, as.rev2);
		const merged = await mergeChange({ remote: remote(), claims: claims(), votes: votes(), policy, stamper: as.a, stampKey: (await claims().read())!.commit.state.stampKey, change: "a-1", agent: "agent-a" });
		expect(merged).toMatchObject({ ok: true });

		// Agent c holds src/c/.
		await claim(claims(), { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "c's work" }, as.c);

		// Agent b claims src/b/, but also edits inside c's claim, gets one approval
		// of two, and merges by hand with trailers citing real tips.
		await claim(claims(), { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b's work" }, as.b);
		const bHead = await pushChange("agent-b", "b-1", { "src/b/y.txt": "b\n", "src/c/z.txt": "not b's\n" });
		await vote(votes(), { commit: bHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" }, as.rev1);
		const rogue = await agentClone("agent-b-rogue");
		await rogue.run("fetch", "--quiet", "origin", "changes/b-1");
		const claimsTip = (await claims().read())!.tip;
		const votesTip = (await votes().read())!.tip;
		await rogue.run("merge", "--quiet", "--no-ff", "FETCH_HEAD", "-m", `Merge b-1\n\nBlueprint-Change: b-1\nBlueprint-Agent: agent-b\nBlueprint-Claims: ${claimsTip}\nBlueprint-Votes: ${votesTip}`);
		await rogue.run("push", "--quiet", "origin", "main");
		const bMerge = await rogue.run("rev-parse", "HEAD");
		// And a "hotfix" straight to main, declaring nothing.
		rogue.write("README.md", "hotfix\n");
		await rogue.run("add", "README.md");
		await rogue.run("commit", "--quiet", "-m", "hotfix");
		await rogue.run("push", "--quiet", "origin", "main");
		const hotfix = await rogue.run("rev-parse", "HEAD");

		const registry = await readRecordHistory<Registry>(remote(), "refs/notes/blueprint-claims/t1");
		const records = {
			registry,
			votes: await readRecordHistory<Votes>(remote(), "refs/notes/blueprint-votes/t1"),
			policy,
			merges: await readMainMerges(remote(), registry[0].state.baseline!),
		};
		expect(records.merges.map((m) => m.change ?? "(none)")).toEqual(["a-1", "b-1", "(none)"]);
		expect(await audit(records)).toEqual([
			{ commit: bMerge, author: "agent-b", rule: "unverified", detail: "the merge has no valid Blueprint stamp: whoever made it, and what its trailers say, is unverified" },
			{ commit: bMerge, author: "agent-b", rule: "inside-another-claim", detail: `src/c/z.txt was claimed by c-1 (agent-c) at ${claimsTip}` },
			{ commit: bMerge, author: "agent-b", rule: "unapproved", detail: `${bHead} had 1 of 2 approvals at ${votesTip}` },
			{ commit: hotfix, author: "agent-b-rogue", rule: "undeclared", detail: "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)" },
		]);
	});

	it("refuses, in the toolkit, to merge a change that breaks a convention", async () => {
		await claim(claims(), { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a's work" }, as.a);
		const aHead = await pushChange("agent-a", "a-1", { "src/a/x.txt": "a\n", "src/elsewhere.txt": "outside\n" });
		await vote(votes(), { commit: aHead, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		const outcome = await mergeChange({ remote: remote(), claims: claims(), votes: votes(), policy, change: "a-1", agent: "agent-a" });
		expect(outcome).toEqual({ ok: false, reasons: ["src/elsewhere.txt is outside a-1's claim", `${aHead} has 1 of 2 approvals from reviewers other than its author`] });
		expect(server.git("rev-list", "--count", "main").trim()).toBe("1");
	});
});
