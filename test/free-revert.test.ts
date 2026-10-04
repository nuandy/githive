import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/election-git";
import { audit } from "../src/free/audit";
import { claim, startFree, type Registry } from "../src/free/claims";
import { readMainMerges, readRecordHistory } from "../src/free/git-records";
import { revertViolation } from "../src/free/revert";
import { generateStampKey, makeStamper, type Stamper } from "../src/free/stamp";
import type { Votes } from "../src/free/votes";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The remedy that goes with detection: any agent may revert a commit the audit
// reports. The revert restores the files the commit changed, as a stamped
// commit naming what it reverts, and the audit then marks those violations
// resolved.

let server: GitServer;
let work: string;
let stamper: Stamper;
const remote = () => ({ url: server.url, token: "unused" });
const claims = () => new GitCasLog<Registry>(async () => remote(), "t1", "refs/notes/blueprint-claims/t1");
const votes = () => new GitCasLog<Votes>(async () => remote(), "t1", "refs/notes/blueprint-votes/t1");
const policy = { required: 1, vetoes: [] };

async function records() {
	const registry = await readRecordHistory<Registry>(remote(), "refs/notes/blueprint-claims/t1");
	return { registry, votes: await readRecordHistory<Votes>(remote(), "refs/notes/blueprint-votes/t1"), policy, merges: await readMainMerges(remote(), registry[0].state.baseline!) };
}

/** A rogue pushes straight to main, editing inside c's claim. */
async function rogueEdit(text = "rogue\n") {
	const rogue = await agentClone(server.url, work, `rogue-${Math.random().toString(36).slice(2, 6)}`);
	rogue.write("src/c/z.txt", text);
	await rogue.run("add", "-A");
	await rogue.run("commit", "--quiet", "-m", "edit c's file");
	await rogue.run("push", "--quiet", "origin", "main");
	return rogue.run("rev-parse", "HEAD");
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "blueprint-revert-"));
	const key = await generateStampKey();
	stamper = await makeStamper(key.privateKey, "service:agent-c");
	await startFree(claims(), { baseline: server.git("rev-parse", "main").trim(), policy, stampKey: key.publicKey });
	await claim(claims(), { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "c's work" }, stamper);
});

afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("free_revert", { timeout: 60_000 }, () => {
	it("reverts a reported commit, and the audit marks its violations resolved", async () => {
		const bad = await rogueEdit();
		const before = await audit(await records());
		expect(before.map((v) => [v.commit, v.rule])).toEqual([[bad, "undeclared"]]);

		const reverted = await revertViolation({ remote: remote(), claims: claims(), votes: votes(), stamper, target: bad, violations: before, agent: "agent-c" });
		expect(reverted).toMatchObject({ ok: true });
		expect(server.git("ls-tree", "-r", "--name-only", "main").includes("src/c/z.txt")).toBe(false);

		const after = await audit(await records());
		expect(after).toEqual([{ ...before[0], resolvedBy: (reverted as { commit: string }).commit }]);
	});

	it("refuses to revert a commit the audit doesn't report", async () => {
		const main = server.git("rev-parse", "main").trim();
		expect(await revertViolation({ remote: remote(), claims: claims(), votes: votes(), stamper, target: main, violations: [], agent: "agent-c" })).toEqual({
			ok: false,
			reasons: [`${main} has no reported violations to revert`],
		});
	});

	it("refuses when the commit's files have changed since, so it must be reverted by hand", async () => {
		const bad = await rogueEdit("first\n");
		await rogueEdit("second\n");
		const violations = await audit(await records());
		expect(await revertViolation({ remote: remote(), claims: claims(), votes: votes(), stamper, target: bad, violations, agent: "agent-c" })).toEqual({
			ok: false,
			reasons: ["src/c/z.txt has changed since; revert it by hand"],
		});
	});
});
