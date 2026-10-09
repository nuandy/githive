import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/git";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Checks read the project's branch from a workspace kept for the isolate, so
// many checks against an unmoved branch clone it once.

let server: GitServer;
const remote = () => ({ url: server.url, token: "unused" });
const head = () => server.git("rev-parse", "main").trim();
const fetches = () => server.requests.filter((r) => r.startsWith("POST git-upload-pack")).length;

beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

describe("a kept workspace", () => {
	it("is cloned once for an unmoved branch", async () => {
		const first = await Workspace.at(remote(), "main", head());
		const before = fetches();
		const second = await Workspace.at(remote(), "main", head());
		expect(fetches()).toBe(before);
		expect(await second.head()).toBe(await first.head());
	});

	it("catches up with one fetch when the branch moves", async () => {
		await Workspace.at(remote(), "main", head());
		const ws = await Workspace.clone(remote(), "main");
		await ws.write({ "next.txt": "next\n" });
		await ws.commit("Next");
		await ws.push();
		const before = fetches();
		const moved = await Workspace.at(remote(), "main", head());
		expect(await moved.head()).toBe(head());
		expect(fetches() - before).toBe(1);
	});

	it("hands each caller its own copy", async () => {
		const a = await Workspace.at(remote(), "main", head());
		await a.write({ "mine.txt": "mine\n" });
		const commit = await a.commit("Only in a");
		const b = await Workspace.at(remote(), "main", head());
		expect(await a.head()).toBe(commit);
		expect(await b.head()).toBe(head());
		await expect(b.fs.promises.readFile("/repo/mine.txt")).rejects.toThrow(/ENOENT/);
	});
});
