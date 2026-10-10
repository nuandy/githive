import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkChange } from "../src/toolkit/check";
import { agentClone, pushChange } from "./helpers/agents";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { forgetChains } from "../src/toolkit/batch-reads";

// An early check of a change against the project's branch. With the branch's
// head kept a moment for every call reading it, it doesn't list the project
// repo itself: check was the busiest reader of a busy project repo.

describe("an early check", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		forgetChains();
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-check-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("takes the branch's head as kept, when there is one, instead of listing the project", async () => {
		const remote = { url: server.url, token: "unused" };
		const main = server.git("rev-parse", "main").trim();
		const head = await pushChange(server.url, work, "agent-a", "a-1", { "src/a.txt": "a\n", "lib/x.txt": "x\n" });
		const claims = [
			{
				change: "a-1",
				agent: "agent-a",
				paths: ["src/"],
				intent: "a",
				since: new Date().toISOString(),
				active: new Date().toISOString(),
			},
		] as never;
		let asked = 0;
		const checked = await checkChange({
			project: remote,
			branch: "main",
			source: remote,
			claims,
			change: "a-1",
			branchHead: async () => (asked++, main),
		});
		expect(asked).toBe(1);
		expect(checked).toMatchObject({ head, main: { head: main, clean: true }, outsideClaim: ["lib/x.txt"] });
		// Without one, it lists the branch itself, as before.
		expect(await checkChange({ project: remote, branch: "main", source: remote, claims, change: "a-1" })).toMatchObject(
			{ head, main: { head: main } },
		);
	});

	/** main moved on after the change left it: a commit to main touching `files`. */
	async function mainMoves(files: Record<string, string>) {
		const lander = await agentClone(server.url, work, `lander-${Math.random().toString(36).slice(2, 6)}`);
		for (const [path, text] of Object.entries(files)) lander.write(path, text);
		await lander.run("add", "-A");
		await lander.run("commit", "--quiet", "-m", "landed");
		await lander.run("push", "--quiet", "origin", "main");
		return server.git("rev-parse", "main").trim();
	}

	it("reads the change through Artifacts' API, nothing fetched, when no file changed on both sides, and says what git says", async () => {
		const remote = { url: server.url, token: "unused" };
		const head = await pushChange(server.url, work, "agent-a", "a-1", { "src/a.txt": "a\n", "lib/x.txt": "x\n" });
		const main = await mainMoves({ "src/other.txt": "other\n" });
		const claims = [
			{
				change: "a-1",
				agent: "agent-a",
				paths: ["src/"],
				intent: "a",
				since: new Date().toISOString(),
				active: new Date().toISOString(),
			},
		] as never;
		const before = server.requests.length;
		const read = await checkChange({
			project: remote,
			branch: "main",
			source: remote,
			claims,
			change: "a-1",
			branchHead: async () => main,
			history: gitHistory(server.git),
		});
		// No Git request: the history was read through the API (played by git here).
		expect(server.requests.length).toBe(before);
		expect(read).toEqual({
			change: "a-1",
			head,
			branch: "main",
			main: { head: main, clean: true },
			outsideClaim: ["lib/x.txt"],
		});
		expect(read).toEqual(
			await checkChange({
				project: remote,
				branch: "main",
				source: remote,
				claims,
				change: "a-1",
				branchHead: async () => main,
			}),
		);
	});

	it("test-merges when the change and main changed the same file, and reports a real conflict", async () => {
		const remote = { url: server.url, token: "unused" };
		await pushChange(server.url, work, "agent-a", "a-1", { "src/same.txt": "a\n" });
		const main = await mainMoves({ "src/same.txt": "main\n" });
		const claims = [
			{
				change: "a-1",
				agent: "agent-a",
				paths: ["src/"],
				intent: "a",
				since: new Date().toISOString(),
				active: new Date().toISOString(),
			},
		] as never;
		const read = await checkChange({
			project: remote,
			branch: "main",
			source: remote,
			claims,
			change: "a-1",
			branchHead: async () => main,
			history: gitHistory(server.git),
		});
		expect(read.main).toEqual({ head: main, clean: false, conflicts: ["src/same.txt"] });
	});
});
