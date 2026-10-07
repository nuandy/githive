import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCasLog, type LogCommit } from "../src/record-log";
import { startGitServer, type GitServer } from "./helpers/git-server";

// A record log in Git, against a real Git server (git http-backend): reads,
// compare-and-swap appends, retries, and entries as notes plain git can read.

type State = { claims: Record<string, string> };

let server: GitServer;
let log: GitCasLog<State>;

beforeEach(async () => {
	server = await startGitServer();
	log = new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1");
});

const commit = (overrides: Partial<LogCommit<State>> = {}): LogCommit<State> => ({
	author: "agent-a",
	kind: "decisions",
	entries: [],
	state: { claims: {} },
	batch: "batch-1",
	...overrides,
});

afterEach(async () => {
	await server.close();
});

describe("GitCasLog", () => {
	it("reads an empty log as nothing", async () => {
		expect(await log.read()).toBeNull();
	});

	it("reads back exactly what was appended, at the tip the append returned", async () => {
		const written = commit({ kind: "decisions", state: { claims: { "src/x/": "agent-a" } } });
		const tip = await log.append(null, written);
		expect(tip).toMatch(/^[0-9a-f]{40}$/);
		expect(await log.read()).toEqual({ tip, commit: written });
	});

	it("retries a read the server fails for a moment", async () => {
		const written = commit({ kind: "decisions" });
		const tip = await log.append(null, written);
		const fresh = new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1");
		server.failFetches(1);
		expect(await fresh.read()).toEqual({ tip, commit: written });
	});

	it("retries a push the server answered with a 500, and counts one it had applied as landed", async () => {
		const first = await log.append(null, commit());
		server.failPushes(1);
		const second = await log.append(first, commit({ batch: "batch-2" }));
		expect(second).toMatch(/^[0-9a-f]{40}$/);
		server.failPushes(1, true);
		const third = await log.append(second, commit({ batch: "batch-3" }));
		expect(third).toMatch(/^[0-9a-f]{40}$/);
		expect((await log.read())?.tip).toBe(third);
		expect(server.git("rev-list", "--count", "refs/notes/githive/t1").trim()).toBe("3");
	});

	it("refuses an append built on a stale tip and leaves the log as it was", async () => {
		const first = await log.append(null, commit());
		const second = await log.append(first, commit({ batch: "batch-2" }));
		expect(await log.append(first, commit({ author: "agent-b", batch: "batch-3" }))).toBeNull();
		expect(await log.read()).toMatchObject({ tip: second, commit: { author: "agent-a", batch: "batch-2" } });
	});

	it("lands exactly one of several appends racing on the same tip", async () => {
		const first = await log.append(null, commit());
		const writers = ["agent-b", "agent-c", "agent-d", "agent-e"];
		const results = await Promise.all(writers.map((author, i) => log.append(first, commit({ author, batch: `race-${i}` }))));
		const landed = results.filter((tip) => tip !== null);
		expect(landed).toHaveLength(1);
		const head = await log.read();
		expect(head?.tip).toBe(landed[0]);
		expect(server.git("rev-list", "--count", "refs/notes/githive/t1").trim()).toBe("2");
	});

	it("lets the server's compare-and-swap decide between pushes that saw the same tip", async () => {
		const first = await log.append(null, commit());
		const pushesBefore = server.pushes();
		// Both pushes are held at the server until both have arrived: neither can
		// see the other's result first.
		const released = server.holdPushes(2);
		const results = await Promise.all([
			log.append(first, commit({ author: "agent-b", batch: "b" })),
			log.append(first, commit({ author: "agent-c", batch: "c" })),
		]);
		await released;
		expect(server.pushes() - pushesBefore).toBe(2);
		expect(results.filter((tip) => tip !== null)).toHaveLength(1);
		expect(server.git("rev-list", "--count", "refs/notes/githive/t1").trim()).toBe("2");
	});

	it("appends on top of its own last commit without reading the log again", async () => {
		const first = await log.append(null, commit());
		server.requests.length = 0;
		const second = await log.append(first, commit({ kind: "decisions", batch: "batch-2" }));
		expect(second).toMatch(/^[0-9a-f]{40}$/);
		// Only the push, in one round trip: no listing of refs, no fetch, no push discovery.
		expect(server.requests).toEqual(["POST git-receive-pack"]);
		expect((await log.read())?.tip).toBe(second);
	});

	it("reads an unchanged log without fetching it again", async () => {
		await new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1").append(null, commit());
		server.requests.length = 0;
		const first = await log.read();
		const firstRequests = server.requests.length;
		server.requests.length = 0;
		expect(await log.read()).toEqual(first);
		expect(server.requests.length).toBeLessThan(firstRequests);
	});

	it("tries a push again when the server is busy, and lands it", async () => {
		const first = await log.append(null, commit());
		server.busyPushes(2);
		const second = await log.append(first, commit({ kind: "decisions", batch: "after-busy" }));
		expect(second).toMatch(/^[0-9a-f]{40}$/);
		expect((await log.read())?.commit.batch).toBe("after-busy");
	});

	it("reports a push that stays busy as not landed, so the caller reads and retries", async () => {
		const first = await log.append(null, commit());
		server.busyPushes(100);
		expect(await log.append(first, commit({ kind: "decisions", batch: "never" }))).toBeNull();
		server.busyPushes(0);
		expect((await log.read())?.tip).toBe(first);
	});

	it("records decisions as Git notes that plain git can read", async () => {
		const project = server.git("rev-parse", "main").trim();
		await log.append(null, commit({ kind: "decisions", entries: [{ commit: project, text: "change stats-1f2e opened, claiming src/stats/", at: "2026-10-04T12:00:00.000Z" }] }));
		expect(server.git("notes", "--ref", "githive/t1", "show", project)).toContain("change stats-1f2e opened, claiming src/stats/");
	});
});
