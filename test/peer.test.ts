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
	async read() {
		const tip = this.commits.at(-1);
		return tip ? { tip: tip.id, commit: structuredClone(tip.commit) } : null;
	}
	async append(parent: string | null, commit: LogCommit<Task>) {
		await new Promise((resolve) => setTimeout(resolve, this.pushMs));
		if ((this.commits.at(-1)?.id ?? null) !== parent) return null;
		const id = `c${this.commits.length + 1}`;
		this.commits.push({ id, commit: structuredClone(commit) });
		return id;
	}
}

let log: SharedLog;
let clock: { now: number };
const LEASE = 30_000;

/** A peer named `name` (a change's peer), on the shared log and clock. */
function peer(name: string) {
	const storage = new FakeStorage();
	const created = new Peer({ storage } as never, fakeEnv().env as never);
	created.configure({ log: () => log, leaseMs: LEASE, now: () => clock.now });
	return { name, peer: created, storage, lead: () => created.lead("t1", "project", name) };
}

const openTask = () => task({ mode: "open", repo: "project", baseRepo: "project", baseCommit: "main0", anchor: "main0", leaseMinutes: 30, verify: [], slices: [] });

beforeEach(async () => {
	io.forks = 0;
	clock = { now: 1_000_000 };
	log = new SharedLog();
	await openLog(log, openTask());
});

describe("a peer of the elected coordinator", () => {
	it("leads the task in term 1 when it is the first to ask", async () => {
		const a = peer("t1--a");
		expect(await a.lead()).toEqual({ leader: "t1--a", term: 1 });
		expect(log.commits.at(-1)?.commit).toMatchObject({ kind: "election", term: 1, leader: "t1--a" });
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
		await a.peer.alarm();
		expect(log.commits.at(-1)?.commit).toMatchObject({ kind: "heartbeat", term: 1, leader: "t1--a" });
		expect(a.storage.alarm).toBe(clock.now + (LEASE * 2) / 3);

		clock.now += LEASE / 2; // past the first lease, inside the renewed one
		expect(await peer("t1--b").lead()).toEqual({ leader: "t1--a", term: 1 });
	});

	it("takes over the task's timers: an expired claim is swept by the new leader's alarm", async () => {
		const expired = new Date(Date.now() - 60_000).toISOString();
		log = new SharedLog();
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

	it("resigns when its own change ends, so the next peer leads at once", async () => {
		const a = peer("t1--stats-1a2b");
		await a.lead();
		await a.peer.openChange({ id: "stats-1a2b", title: "Stats", intent: "Stats", owns: ["src/stats/"] });
		await a.peer.abandonChange("stats-1a2b", "done here");
		expect(log.commits.at(-1)?.commit).toMatchObject({ kind: "resignation", term: 1, leader: "t1--stats-1a2b" });
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
});
