import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkChange } from "../src/toolkit/check";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";

// An early check of a change against the project's branch. With the branch's
// head kept a moment for every call reading it, it doesn't list the project
// repo itself: check was the busiest reader of a busy project repo.

describe("an early check", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
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
		const claims = [{ change: "a-1", agent: "agent-a", paths: ["src/"], intent: "a", since: new Date().toISOString(), active: new Date().toISOString() }] as never;
		let asked = 0;
		const checked = await checkChange({ project: remote, branch: "main", source: remote, claims, change: "a-1", branchHead: async () => (asked++, main) });
		expect(asked).toBe(1);
		expect(checked).toMatchObject({ head, main: { head: main, clean: true }, outsideClaim: ["lib/x.txt"] });
		// Without one, it lists the branch itself, as before.
		expect(await checkChange({ project: remote, branch: "main", source: remote, claims, change: "a-1" })).toMatchObject({ head, main: { head: main } });
	});
});
