import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Landing, memoryLanding } from "../src/toolkit/landing";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A claim can outlast its change's landing (demo run 17's did, until the next run released it). Released then, it
// names the merge, as merge's own release does, so the audit doesn't read it as given up before the merge.

let server: GitServer;
let landing: Landing;
const { call, register } = toolCalls(() => server, { landing: () => landing });

beforeEach(async () => {
	server = await startGitServer();
	landing = memoryLanding();
	await register("a");
	await call("settings", { required: 1, vetoes: [] });
	await call("claim", { change: "x", agent: "a", paths: ["src/x/"], intent: "x" }, "a");
});
afterEach(async () => {
	await server.close();
});

const landedAt = (at: string) =>
	landing.settle([{ change: "x", head: "h1", agent: "a", how: "landed", at, commit: "m1" }]);

it("names the merge when it releases a claim whose change landed while it was held", async () => {
	await landedAt(new Date().toISOString());
	await call("release", { change: "x", agent: "a", reason: "demo run 18 starts over" }, "a");
	expect((await call("status", { change: "x" })).released).toMatchObject({ mergedAs: "m1" });
});

it("names no merge for a landing from before the claim, an earlier change under the same name", async () => {
	await landedAt("2026-10-01T00:00:00.000Z");
	await call("release", { change: "x", agent: "a" }, "a");
	expect((await call("status", { change: "x" })).released).not.toHaveProperty("mergedAs");
});

it("releases a claim whose change landed at its head when the change's status is read", async () => {
	const work = mkdtempSync(join(tmpdir(), "githive-release-landed-"));
	try {
		const head = await pushChange(server.url, work, "a", "x", { "src/x/a.txt": "x\n" });
		await landing.settle([
			{ change: "x", head, agent: "a", how: "landed", at: new Date().toISOString(), commit: "m1" },
		]);
		expect(await call("status", { change: "x", agent: "a" }, "a")).toMatchObject({ landed: { commit: "m1" } });
		expect(await call("claims", {})).toEqual([]);
		expect((await call("status", { change: "x" })).released).toMatchObject({ reason: "merged", mergedAs: "m1" });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
