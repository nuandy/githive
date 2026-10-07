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
		expect(await log.read()).toEqual({ tip, commit: { ...written, format: 1 } });
	});

	it("retries a read the server fails for a moment", async () => {
		const written = commit({ kind: "decisions" });
		const tip = await log.append(null, written);
		const fresh = new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1");
		server.failFetches(1);
		expect(await fresh.read()).toEqual({ tip, commit: { ...written, format: 1 } });
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

	it("says the record format each commit is in, and reads a commit from before formats as format 1", async () => {
		await log.append(null, commit());
		expect(server.git("log", "-1", "--format=%B", "refs/notes/githive/t1")).toMatch(/^GitHive-Format: 1$/m);
		const { formatOf } = await import("../src/record-format");
		expect(formatOf("Old commit\n\nGitHive-Author: x\nGitHive-Kind: decisions\nGitHive-Batch: b\n")).toBe(1);
	});
});

describe("a rehearsed change of record format", () => {
	type V1 = { claims: Record<string, string> };
	type V2 = { claims: Record<string, { holder: string }> };
	// Format 2 keeps each holder in an object: the upgrade keeps every claim, holder and all.
	const upgrades = { 1: (state: unknown) => ({ claims: Object.fromEntries(Object.entries((state as V1).claims).map(([path, holder]) => [path, { holder }])) }) };
	const v1 = () => new GitCasLog<V1>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1");
	const v2 = () => new GitCasLog<V2>(async () => ({ url: server.url, token: "unused" }), "t1", "refs/notes/githive/t1", { format: 2, upgrades });

	it("upgrades format 1 records as a format 2 GitHive reads them, losing nothing", async () => {
		const first = await v1().append(null, commit({ state: { claims: { "src/a/": "agent-a", "docs/": "agent-b" } } }));
		const read = await v2().read();
		expect(read?.commit.format).toBe(1);
		expect(read?.commit.state).toEqual({ claims: { "src/a/": { holder: "agent-a" }, "docs/": { holder: "agent-b" } } });
		// It writes on in its own format, on top of the old records.
		const next = await v2().append(first, { ...commit(), state: { claims: { ...read!.commit.state.claims, "web/": { holder: "agent-c" } } } } as never);
		expect(next).toMatch(/^[0-9a-f]{40}$/);
		expect(server.git("log", "-1", "--format=%B", "refs/notes/githive/t1")).toMatch(/^GitHive-Format: 2$/m);
		expect((await v2().read())?.commit.state.claims["web/"]).toEqual({ holder: "agent-c" });
	});

	it("never lets an older GitHive write over newer records: it reads them as they are, and refuses", async () => {
		const tip = await v2().append(null, { ...commit(), state: { claims: { "src/a/": { holder: "agent-a" } } } } as never);
		const older = v1();
		const read = await older.read();
		expect(read?.commit.format).toBe(2);
		expect(read?.commit.state).toEqual({ claims: { "src/a/": { holder: "agent-a" } } });
		await expect(older.append(tip, commit({ batch: "older" }))).rejects.toThrow("these records are format 2, newer than this GitHive knows (1): it reads them but won't write over them");
		// Nor without reading first.
		await expect(v1().append(tip, commit({ batch: "older-blind" }))).rejects.toThrow(/newer than this GitHive knows/);
		expect((await v2().read())?.tip).toBe(tip);
	});

	it("needs an upgrade for every step: a missing one is an error, never a silent guess", async () => {
		const { upgradeState } = await import("../src/record-format");
		expect(() => upgradeState({}, 1, "refs/x", 3, { 1: (s) => s })).toThrow("no upgrade from record format 2 to 3");
	});
});

