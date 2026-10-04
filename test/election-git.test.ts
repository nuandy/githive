import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deposed, type LogCommit, campaign } from "../src/election";
import { GitCasLog, cachedRemote, leaseRef } from "../src/election-git";
import { startGitServer, type GitServer } from "./helpers/git-server";

// The log in Git, against a real Git server (git http-backend).

type State = { claims: Record<string, string> };

let server: GitServer;
let log: GitCasLog<State>;

beforeEach(async () => {
	server = await startGitServer();
	log = new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1");
});

const commit = (overrides: Partial<LogCommit<State>> = {}): LogCommit<State> => ({
	term: 1,
	leader: "peer-a",
	leaseUntil: 1_790_000_000_000,
	kind: "election",
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
		const written = commit({ kind: "decisions", state: { claims: { "src/x/": "peer-a" } } });
		const tip = await log.append(null, written);
		expect(tip).toMatch(/^[0-9a-f]{40}$/);
		expect(await log.read()).toEqual({ tip, commit: written });
	});

	it("retries a read the server fails for a moment", async () => {
		const written = commit({ kind: "decisions" });
		const tip = await log.append(null, written);
		const fresh = new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1");
		server.failFetches(1);
		expect(await fresh.read()).toEqual({ tip, commit: written });
	});

	it("refuses an append built on a stale tip and leaves the log as it was", async () => {
		const first = await log.append(null, commit());
		const second = await log.append(first, commit({ term: 2, batch: "batch-2" }));
		expect(await log.append(first, commit({ term: 2, leader: "peer-b", batch: "batch-3" }))).toBeNull();
		expect(await log.read()).toMatchObject({ tip: second, commit: { term: 2, leader: "peer-a" } });
	});

	it("lands exactly one of several appends racing on the same tip", async () => {
		const first = await log.append(null, commit());
		const peers = ["peer-b", "peer-c", "peer-d", "peer-e"];
		const results = await Promise.all(peers.map((leader, i) => log.append(first, commit({ term: 2, leader, batch: `race-${i}` }))));
		const landed = results.filter((tip) => tip !== null);
		expect(landed).toHaveLength(1);
		const head = await log.read();
		expect(head?.tip).toBe(landed[0]);
		expect(server.git("rev-list", "--count", "refs/notes/blueprint/t1").trim()).toBe("2");
	});

	it("lets the server's compare-and-swap decide between pushes that saw the same tip", async () => {
		const first = await log.append(null, commit());
		const pushesBefore = server.pushes();
		// Both pushes are held at the server until both have arrived: neither can
		// see the other's result first.
		const released = server.holdPushes(2);
		const results = await Promise.all([
			log.append(first, commit({ term: 2, leader: "peer-b", batch: "b" })),
			log.append(first, commit({ term: 2, leader: "peer-c", batch: "c" })),
		]);
		await released;
		expect(server.pushes() - pushesBefore).toBe(2);
		expect(results.filter((tip) => tip !== null)).toHaveLength(1);
		expect(server.git("rev-list", "--count", "refs/notes/blueprint/t1").trim()).toBe("2");
	});

	it("appends on top of its own last commit without reading the log again", async () => {
		const first = await log.append(null, commit());
		server.requests.length = 0;
		const second = await log.append(first, commit({ term: 1, kind: "decisions", batch: "batch-2" }));
		expect(second).toMatch(/^[0-9a-f]{40}$/);
		// Only the push, in one round trip: no listing of refs, no fetch, no push discovery.
		expect(server.requests).toEqual(["POST git-receive-pack"]);
		expect((await log.read())?.tip).toBe(second);
	});

	it("reads an unchanged log without fetching it again", async () => {
		await new GitCasLog<State>(async () => ({ url: server.url, token: "unused" }), "t1").append(null, commit());
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
		expect(server.git("notes", "--ref", "blueprint/t1", "show", project)).toContain("change stats-1f2e opened, claiming src/stats/");
	});
});

describe("the election protocol over Git", () => {
	const empty = (): State => ({ claims: {} });
	const claim = (path: string, holder: string) => (state: State) => {
		if (state.claims[path]) throw new Error(`[409] ${path} is held by ${state.claims[path]}`);
		return { state: { claims: { ...state.claims, [path]: holder } }, entries: [{ commit: "none", text: `${holder} claims ${path}`, at: "" }], result: path };
	};

	it("elects, decides, fences a stale leader and hands every decision to the next", async () => {
		const c = { now: 1_000_000 };
		const options = { leaseMs: 30_000, now: () => c.now };
		const refs = { log, leases: new GitCasLog<null>(async () => ({ url: server.url, token: "unused" }), "t1", leaseRef("t1")) };
		const a = await campaign(refs, "peer-a", empty, options);
		if (!a.leading) throw new Error("peer-a should lead");
		expect(await campaign(refs, "peer-b", empty, options)).toMatchObject({ leading: false, leader: "peer-a" });
		await a.leader.decide(claim("src/x/", "peer-a"));
		c.now += 20_000;
		expect(await a.leader.heartbeat()).toBe(true);

		c.now += 30_001;
		const b = await campaign(refs, "peer-b", empty, options);
		if (!b.leading) throw new Error("peer-b should lead");
		expect(b.term).toBe(2);
		await expect(a.leader.decide(claim("src/y/", "peer-a"))).rejects.toBeInstanceOf(Deposed);
		await expect(b.leader.decide(claim("src/x/", "peer-b"))).rejects.toThrow(/held by peer-a/);
		await b.leader.decide(claim("src/y/", "peer-b"));

		expect((await log.read())?.commit.state).toEqual({ claims: { "src/x/": "peer-a", "src/y/": "peer-b" } });
		const history = server.git("log", "--format=%(trailers:key=Blueprint-Term,valueonly,separator=)|%(trailers:key=Blueprint-Kind,valueonly,separator=)|%s", "refs/notes/blueprint/t1").trim().split("\n");
		// The decision log holds only terms and decisions; the heartbeat went to the lease ref.
		expect(history.reverse()).toEqual(["1|term|Term 1: peer-a leads", "1|decisions|peer-a claims src/x/", "2|term|Term 2: peer-b leads", "2|decisions|peer-b claims src/y/"]);
		const leases = server.git("log", "--format=%s", leaseRef("t1")).trim().split("\n").reverse();
		expect(leases).toEqual(["Election: peer-a leads term 1", "Heartbeat: peer-a, term 1", "Election: peer-b leads term 2"]);
	});
});

describe("cachedRemote", () => {
	it("mints a token once while it is fresh, and again once it is not", async () => {
		let now = 0;
		const mint = vi.fn(async () => ({ url: "https://git.test/p.git", token: `t${mint.mock.calls.length}` }));
		const remote = cachedRemote(mint, 60_000, () => now);
		expect(await remote()).toEqual(await remote());
		expect(mint).toHaveBeenCalledTimes(1);
		now += 60_001;
		await remote();
		expect(mint).toHaveBeenCalledTimes(2);
	});
});
