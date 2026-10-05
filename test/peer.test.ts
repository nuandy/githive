import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CasLog, LogCommit } from "../src/election";
import type { Task } from "../src/types";
import { FakeStorage, fakeEnv, slice, task } from "./fakes/env";

// Peers of the elected coordinator: several Peer objects sharing one log, as
// separate Durable Objects would share the task's notes ref. Artifacts and git
// I/O are mocked as in the Coordinator tests.

const io = vi.hoisted(() => ({ forks: 0 }));

vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	headOf: vi.fn(async () => "main0"),
	forkAndWait: vi.fn(async (_artifacts: unknown, _source: string, name: string) => {
		io.forks++;
		return { remote: `https://git.test/${name}.git`, token: `token-${name}` };
	}),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));

const { Peer } = await import("../src/peer");
const { openLog } = await import("../src/peer");

/** The task's log, shared by every peer, with Git's push semantics. */
class SharedLog implements CasLog<Task> {
	commits: { id: string; commit: LogCommit<Task> }[] = [];
	/** How long a push takes; a real one takes a second or more. */
	pushMs = 0;
	/** When set, pushes wait until it resolves (to hold a commit in flight). */
	gate: Promise<void> | null = null;
	reads = 0;
	async read() {
		this.reads++;
		const tip = this.commits.at(-1);
		return tip ? { tip: tip.id, commit: structuredClone(tip.commit) } : null;
	}
	async append(parent: string | null, commit: LogCommit<Task>) {
		await new Promise((resolve) => setTimeout(resolve, this.pushMs));
		await this.gate;
		if ((this.commits.at(-1)?.id ?? null) !== parent) return null;
		const id = `c${this.commits.length + 1}`;
		this.commits.push({ id, commit: structuredClone(commit) });
		return id;
	}
}

let log: SharedLog;
let leases: SharedLog;
let clock: { now: number };
const LEASE = 30_000;

/** A peer named `name` (a change's peer), on the shared log and clock. */
/** Every peer made in a test, by name: how peers reach each other, as Durable Objects would. */
let registry: Map<string, InstanceType<typeof Peer>>;

/** Leader hints peers report to the task index. */
let hints: { id: string; name: string | null; term: number }[];
/** Summaries peers keep in the task index, for the dashboard's repo list. */
let summaries: { key: string; patch: Record<string, unknown> }[];
/** Pings to the dashboard's live feeds. */
let pings: string[];

function peer(name: string, storage = new FakeStorage()) {
	const env = {
		...fakeEnv().env,
		PEER: { getByName: (n: string) => registry.get(n) },
		TASK_INDEX: {
			getByName: () => ({
				hintLeader: async (id: string, leader: string | null, term: number) => void hints.push({ id, name: leader, term }),
				summarize: async (key: string, patch: Record<string, unknown>) => void summaries.push({ key, patch }),
			}),
		},
		LIVE: { getByName: (key: string) => ({ ping: async () => void pings.push(key) }) },
	};
	const created = new Peer({ storage } as never, env as never);
	created.configure({ log: () => log, leases: () => leases as never, leaseMs: LEASE, now: () => clock.now });
	registry.set(name, created);
	return { name, peer: created, storage, lead: () => created.lead("t1", "project", name), peek: () => created.peek("t1", "project", name) };
}

const openTask = () => task({ mode: "open", repo: "project", baseRepo: "project", baseCommit: "main0", anchor: "main0", leaseMinutes: 30, verify: [], slices: [] });

beforeEach(async () => {
	io.forks = 0;
	registry = new Map();
	hints = [];
	summaries = [];
	pings = [];
	clock = { now: 1_000_000 };
	log = new SharedLog();
	leases = new SharedLog();
	await openLog(log, openTask());
});

describe("a peer of the elected coordinator", () => {
	it("leads the task in term 1 when it is the first to ask", async () => {
		const a = peer("t1--a");
		expect(await a.lead()).toEqual({ leader: "t1--a", term: 1 });
		expect(leases.commits.at(-1)?.commit).toMatchObject({ kind: "election", term: 1, leader: "t1--a" });
		expect(log.commits.at(-1)?.commit).toMatchObject({ kind: "term", term: 1, leader: "t1--a" });
	});

	it("tells a second peer who leads, without writing to the log", async () => {
		await peer("t1--a").lead();
		const commits = log.commits.length;
		expect(await peer("t1--b").lead()).toEqual({ leader: "t1--a", term: 1 });
		expect(log.commits).toHaveLength(commits);
	});

	it("runs open-mode decisions as leader, answering once they are in the log", async () => {
		const a = peer("t1--a");
		await a.lead();
		const { change } = await a.peer.openChange({ title: "Add stats", intent: "Add stats, please", owns: ["src/stats/"] });
		expect(change).toMatchObject({ status: "building", owns: ["src/stats/"] });
		const tip = log.commits.at(-1)!.commit;
		expect(tip).toMatchObject({ term: 1, leader: "t1--a", kind: "decisions" });
		expect(tip.state.slices.map((s) => [s.id, s.status])).toEqual([[change.id, "building"]]);
		expect(log.commits.flatMap((c) => c.commit.entries.map((e) => e.text)).join("\n")).toMatch(/opened: "Add stats", claiming src\/stats\//);
	});

	it("hands the task to the next peer once the lease runs out, and fences the old leader", async () => {
		const a = peer("t1--a");
		await a.lead();
		const { change } = await a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		const commits = log.commits.length;

		clock.now += LEASE + 1;
		const b = peer("t1--b");
		expect(await b.lead()).toEqual({ leader: "t1--b", term: 2 });
		// The new leader holds the old one's grants.
		await expect(b.peer.openChange({ title: "Mine", intent: "Mine", owns: ["src/stats/x.ts"] })).rejects.toThrow(new RegExp(`held by change ${change.id}`));
		expect((await b.peer.claims()).map((c) => c.change)).toEqual([change.id]);

		// The old leader is refused, and nothing it does lands.
		await expect(a.peer.openChange({ title: "Late", intent: "Late", owns: ["src/late/"] })).rejects.toThrow(/no longer leading/);
		expect(log.commits.slice(commits).every((c) => c.commit.term === 2)).toBe(true);
		await expect(a.peer.claims()).rejects.toThrow(/no longer leading/);
	});

	it("fails over: a crashed leader stops answering and renewing, and another peer leads once its lease runs out, with every decision", async () => {
		const a = peer("t1--a");
		await a.lead();
		const { change } = await a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await a.peer.simulateCrash(2 * LEASE);
		await expect(a.peer.claims()).rejects.toThrow(/unavailable/);
		await expect(a.lead()).rejects.toThrow(/unavailable/);

		// Its alarm renews nothing: the lease runs out.
		const renewals = leases.commits.length;
		clock.now += LEASE / 2;
		await a.peer.alarm();
		expect(leases.commits).toHaveLength(renewals);

		// Until it does, the others still see it leading; then the next to ask takes over, with its grants.
		const b = peer("t1--b");
		expect(await b.lead()).toEqual({ leader: "t1--a", term: 1 });
		clock.now += LEASE;
		expect(await b.peer.lead("t1", "project", "t1--b", true)).toEqual({ leader: "t1--b", term: 2 });
		expect((await b.peer.claims()).map((c) => c.change)).toEqual([change.id]);

		// Back after its crash, while the new leader's lease is live, it doesn't lead.
		clock.now += 0.6 * LEASE;
		await expect(a.peer.openChange({ title: "Late", intent: "Late", owns: ["src/late/"] })).rejects.toThrow(/no longer leading/);
	});

	it("stays down through a restart of its object, until its crash is over", async () => {
		const storage = new FakeStorage();
		const a = peer("t1--a", storage);
		await a.lead();
		await a.peer.simulateCrash(LEASE);
		const restarted = peer("t1--a", storage);
		await expect(restarted.lead()).rejects.toThrow(/unavailable/);
	});

	it("writes nothing to the log for a refused decision", async () => {
		const a = peer("t1--a");
		await a.lead();
		await a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		const commits = log.commits.length;
		await expect(a.peer.openChange({ title: "Again", intent: "Again", owns: ["src/stats/"] })).rejects.toThrow(/already claimed/);
		expect(log.commits).toHaveLength(commits);
	});

	it("keeps leading while idle by renewing its lease from its alarm", async () => {
		const a = peer("t1--a");
		await a.lead();
		const due = clock.now + (LEASE * 2) / 3;
		expect(a.storage.alarm).toBe(due);

		clock.now = due;
		const logLength = log.commits.length;
		await a.peer.alarm();
		expect(leases.commits.at(-1)?.commit).toMatchObject({ kind: "heartbeat", term: 1, leader: "t1--a" });
		expect(log.commits).toHaveLength(logLength);
		expect(a.storage.alarm).toBe(clock.now + (LEASE * 2) / 3);

		clock.now += LEASE / 2; // past the first lease, inside the renewed one
		expect(await peer("t1--b").lead()).toEqual({ leader: "t1--a", term: 1 });
	});

	it("takes over the task's timers: an expired claim is swept by the new leader's alarm", async () => {
		const expired = new Date(Date.now() - 60_000).toISOString();
		log = new SharedLog();
		leases = new SharedLog();
		await openLog(log, { ...openTask(), slices: [slice("stale", { startCommit: "main0", leaseUntil: expired })] });
		// Claim leases are real times, so this test runs the peers on the real clock.
		clock.now = Date.now();
		const a = peer("t1--a");
		await a.lead();
		// Due now, not when the lease next needs renewing.
		expect(a.storage.alarm).toBeLessThanOrEqual(Date.now());

		await a.peer.alarm();
		expect(log.commits.at(-1)?.commit.state.slices[0].status).toBe("abandoned");
		expect(log.commits.flatMap((c) => c.commit.entries.map((e) => e.text)).join("\n")).toMatch(/Change stale abandoned/);
	});

	it("keeps leading while other changes are active, and resigns when the last one ends", async () => {
		const a = peer("t1--stats-1a2b");
		await a.lead();
		await a.peer.openChange({ id: "stats-1a2b", title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await a.peer.openChange({ id: "docs-3c4d", title: "Docs", intent: "Docs", owns: ["docs/"] });

		// Its own change ends, but another is active: it stays in charge.
		await a.peer.abandonChange("stats-1a2b", "done here");
		expect(leases.commits.at(-1)?.commit.kind).not.toBe("resignation");
		expect(await peer("t1--x").lead()).toEqual({ leader: "t1--stats-1a2b", term: 1 });

		// The last active change ends: nothing left to coordinate, so it hands over.
		await a.peer.abandonChange("docs-3c4d", "done too");
		expect(leases.commits.at(-1)?.commit).toMatchObject({ kind: "resignation", term: 1, leader: "t1--stats-1a2b" });
		expect(await peer("t1--b").lead()).toEqual({ leader: "t1--b", term: 2 });
	});

	it("commits concurrent decisions together rather than one push per step", async () => {
		const a = peer("t1--a");
		await a.lead();
		const before = log.commits.length;
		log.pushMs = 20;
		const opened = await Promise.all(Array.from({ length: 10 }, (_, i) => a.peer.openChange({ title: `c${i}`, intent: "x", owns: [`src/c${i}/`] })));
		expect(new Set(opened.map((o) => o.change.id)).size).toBe(10);
		// Each change takes two steps (reserve, confirm): 20 steps in all.
		expect(log.commits.length - before).toBeLessThan(20);
		expect(log.commits.at(-1)?.commit.state.slices.filter((s) => s.status === "building")).toHaveLength(10);
	});

	it("answers lead() from memory while it knows a live lease, without reading the log", async () => {
		const a = peer("t1--a");
		const b = peer("t1--b");
		await a.lead();
		await b.lead();
		const reads = log.reads;
		expect(await a.lead()).toEqual({ leader: "t1--a", term: 1 });
		expect(await b.lead()).toEqual({ leader: "t1--a", term: 1 });
		expect(log.reads).toBe(reads);

		// Once that lease has ended, b looks again (and takes over).
		clock.now += LEASE + 1;
		expect(await b.lead()).toEqual({ leader: "t1--b", term: 2 });
		expect(log.reads).toBeGreaterThan(reads);
	});

	it("looks in the log again when asked to, after the leader it remembers stepped down", async () => {
		const a = peer("t1--stats-1a2b");
		const b = peer("t1--b");
		await a.lead();
		expect(await b.lead()).toMatchObject({ leader: "t1--stats-1a2b" });
		await a.peer.openChange({ id: "stats-1a2b", title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await a.peer.abandonChange("stats-1a2b", "done");
		expect(await b.lead()).toMatchObject({ leader: "t1--stats-1a2b" }); // still remembered
		expect(await b.peer.lead("t1", "project", "t1--b", true)).toEqual({ leader: "t1--b", term: 2 });
	});

	it("keeps one log for the task rather than opening it on every call", async () => {
		const storage = new FakeStorage();
		const opened = vi.fn(() => log);
		const a = new Peer({ storage } as never, fakeEnv().env as never);
		a.configure({ log: opened, leases: () => leases as never, leaseMs: LEASE, now: () => clock.now });
		await a.lead("t1", "project", "t1--a");
		clock.now += LEASE + 1;
		await a.lead("t1", "project", "t1--a", true);
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("answers reads from the leader's memory, without reading the log", async () => {
		const a = peer("t1--a");
		await a.lead();
		await a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		const reads = log.reads;
		expect((await a.peek()).slices.map((s) => s.owns)).toEqual([["src/stats/"]]);
		expect(log.reads).toBe(reads);
	});

	it("has a follower ask the leader for reads rather than Git", async () => {
		const a = peer("t1--a");
		const b = peer("t1--b");
		await a.lead();
		await b.lead();
		await a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		const reads = log.reads;
		expect((await b.peek()).slices).toHaveLength(1);
		expect(log.reads).toBe(reads);
	});

	it("reads the log when it knows of no live leader", async () => {
		const reader = peer("t1--b");
		expect((await reader.peek()).id).toBe("t1");
		expect(log.commits.every((c) => c.commit.kind === "genesis")).toBe(true); // reading never campaigns
		expect(leases.commits).toEqual([]);
	});


	it("checks with the leader it remembers once that lease has passed, rather than reading the log", async () => {
		const a = peer("t1--a");
		const reader = peer("t1--b");
		await a.lead();
		await reader.peek(); // learns who leads
		clock.now += (LEASE * 2) / 3;
		await a.peer.alarm(); // the leader renews
		clock.now += LEASE / 2; // past the lease the reader saw, inside the renewed one
		const reads = log.reads;
		expect((await reader.peek()).id).toBe("t1");
		expect(log.reads).toBe(reads);
	});

	it("starts the fork without waiting for the reservation to land, and answers once both have", async () => {
		const a = peer("t1--a");
		await a.lead();
		let release!: () => void;
		log.gate = new Promise((resolve) => (release = resolve));
		const before = log.commits.length;
		const opening = a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		// The fork has started while no commit has landed yet.
		await vi.waitFor(() => expect(io.forks).toBe(1));
		expect(log.commits.length).toBe(before);
		// A racing claim is refused at once, from the leader's memory.
		await expect(a.peer.openChange({ title: "Race", intent: "Race", owns: ["src/stats/x.ts"] })).rejects.toThrow(/already claimed/);
		let answered = false;
		void opening.then(() => (answered = true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(answered).toBe(false);
		log.gate = null;
		release();
		const { change } = await opening;
		expect(log.commits.at(-1)?.commit.state.slices.find((s) => s.id === change.id)?.status).toBe("building");
	});

	it("fails the open if the reservation never lands", async () => {
		const a = peer("t1--a");
		await a.lead();
		clock.now += LEASE + 1;
		await peer("t1--b").lead(); // a is deposed, and doesn't know yet
		await expect(a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] })).rejects.toThrow(/no longer leading/);
		expect(log.commits.flatMap((c) => c.commit.state.slices)).toEqual([]);
	});

	it("rejoins as leader after its object restarts, when asked to decide", async () => {
		const a = peer("t1--a");
		await a.lead();
		// The object is evicted: a new instance with the same storage and nothing in memory.
		const restarted = peer("t1--a", a.storage);
		const { change } = await restarted.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		expect(change.status).toBe("building");
		expect(log.commits.at(-1)?.commit).toMatchObject({ term: 1, leader: "t1--a", kind: "decisions" });
		expect(leases.commits.filter((c) => c.commit.kind === "election")).toHaveLength(1);
	});

	it("keeps renewing its lease from its alarm after its object restarts", async () => {
		const a = peer("t1--a");
		await a.lead();
		const restarted = peer("t1--a", a.storage);
		clock.now += (LEASE * 2) / 3;
		await restarted.peer.alarm();
		expect(leases.commits.at(-1)?.commit).toMatchObject({ kind: "heartbeat", term: 1, leader: "t1--a" });
	});

	it("keeps the task's summary in the index as decisions commit, writing only when the counts change", async () => {
		const a = peer("t1--stats-1a2b");
		await a.lead();
		await a.peer.openChange({ id: "stats-1a2b", title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		expect(summaries.at(-1)).toMatchObject({ key: "task:t1", patch: { open: 1, needsYou: 0, merged: 0, abandoned: 0 } });
		// And the dashboard's open pages are told at once.
		expect(pings).toContain("task:t1");
		const written = summaries.length;
		await a.peer.extendClaim("stats-1a2b", ["src/stats/", "docs/stats.md"]);
		expect(summaries).toHaveLength(written);
		await a.peer.abandonChange("stats-1a2b", "done");
		expect(summaries.at(-1)).toMatchObject({ key: "task:t1", patch: { open: 0, abandoned: 1 } });
	});

	it("tells the task index it leads when it wins a term, and that nobody does when it resigns", async () => {
		const a = peer("t1--stats-1a2b");
		await a.lead();
		expect(hints).toEqual([{ id: "t1", name: "t1--stats-1a2b", term: 1 }]);
		await a.peer.openChange({ id: "stats-1a2b", title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await a.peer.abandonChange("stats-1a2b", "done");
		expect(hints.at(-1)).toEqual({ id: "t1", name: null, term: 1 });
	});

	it("campaigns once for concurrent lead() calls, so a peer never holds two leaders for one term", async () => {
		const a = peer("t1--a");
		await Promise.all([a.lead(), a.lead(), a.lead()]);
		expect(leases.commits.filter((c) => c.commit.kind === "election")).toHaveLength(1);
		expect(log.commits.filter((c) => c.commit.kind === "term")).toHaveLength(1);
	});

	it("renews rather than re-campaigns when its lease has passed in its own view, keeping decisions in flight", async () => {
		const a = peer("t1--a");
		await a.lead();
		let release!: () => void;
		log.gate = new Promise((resolve) => (release = resolve));
		const opening = a.peer.openChange({ title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await vi.waitFor(() => expect(io.forks).toBe(1));
		// Its alarm was late: the lease it holds has passed by its own clock.
		clock.now += LEASE + 1;
		expect(await a.lead()).toEqual({ leader: "t1--a", term: 1 });
		log.gate = null;
		release();
		const { change } = await opening;
		expect(change.status).toBe("building");
		expect(log.commits.filter((c) => c.commit.kind === "term")).toHaveLength(1);
	});
});
