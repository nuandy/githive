import { describe, expect, it } from "vitest";
import { Deposed, type CasLog, type LogCommit, campaign } from "../src/election";

// The elected-coordinator protocol over in-memory compare-and-swap refs: the
// decision log and the lease ref. Safety comes only from compare-and-swap
// appends to the decision log, fenced by term; the lease ref and clocks only
// decide when a peer may try to take over.

type State = { claims: Record<string, string> };

/** An in-memory ref with Git's push semantics: an append lands only on the tip it was built on. */
class MemoryLog<S> implements CasLog<S> {
	commits: { id: string; parent: string | null; commit: LogCommit<S> }[] = [];
	appends = 0;
	/** Runs before an append lands; lets a test interleave another writer or slow the push. */
	beforeAppend: (() => Promise<void>) | null = null;
	/** Make the next append land but report a network failure, as a lost acknowledgement would. */
	loseNextAck = false;

	constructor(private readonly name: string) {}

	tip() {
		return this.commits.at(-1) ?? null;
	}
	async read() {
		const tip = this.tip();
		return tip ? { tip: tip.id, commit: structuredClone(tip.commit) } : null;
	}
	async append(parent: string | null, commit: LogCommit<S>) {
		const hook = this.beforeAppend;
		this.beforeAppend = null;
		await hook?.();
		this.appends++;
		if ((this.tip()?.id ?? null) !== parent) return null;
		const id = `${this.name}${this.commits.length + 1}`;
		this.commits.push({ id, parent, commit: structuredClone(commit) });
		if (this.loseNextAck) {
			this.loseNextAck = false;
			throw new Error("connection reset");
		}
		return id;
	}
	/** Every decision ever landed, in order. */
	decisions() {
		return this.commits.flatMap((c) => c.commit.entries.map((e) => e.text));
	}
}

const LEASE = 30_000;
const clock = (start = 1_000_000) => {
	const c = { now: start, advance: (ms: number) => void (c.now += ms) };
	return c;
};
const options = (c: { now: number }) => ({ leaseMs: LEASE, now: () => c.now });
const empty = (): State => ({ claims: {} });
const refs = () => ({ log: new MemoryLog<State>("d"), leases: new MemoryLog<null>("l") });

/** A decision that claims `path` for `holder`, refused if someone holds it. */
const claim = (path: string, holder: string) => (state: State) => {
	if (state.claims[path]) throw new Error(`[409] ${path} is held by ${state.claims[path]}`);
	return { state: { claims: { ...state.claims, [path]: holder } }, entries: [{ commit: "c0", text: `${holder} claims ${path}`, at: "" }], result: path };
};

describe("campaign", () => {
	it("makes the first peer the leader of term 1: a lease, and a term marker in the decision log", async () => {
		const r = refs();
		const c = clock();
		expect(await campaign(r, "a", empty, options(c))).toMatchObject({ leading: true, term: 1 });
		expect(r.leases.tip()?.commit).toMatchObject({ term: 1, leader: "a", kind: "election", leaseUntil: c.now + LEASE });
		expect(r.log.tip()?.commit).toMatchObject({ term: 1, leader: "a", kind: "term" });
	});

	it("elects exactly one of two peers campaigning at once", async () => {
		const r = refs();
		const c = clock();
		const [a, b] = await Promise.all([campaign(r, "a", empty, options(c)), campaign(r, "b", empty, options(c))]);
		expect([a.leading, b.leading].filter(Boolean)).toHaveLength(1);
		const loser = a.leading ? b : a;
		expect(loser).toMatchObject({ leading: false, term: 1, leader: a.leading ? "a" : "b" });
		expect(r.leases.commits.filter((x) => x.commit.kind === "election")).toHaveLength(1);
		expect(r.log.commits.filter((x) => x.commit.kind === "term")).toHaveLength(1);
	});

	it("leaves a leader with a live lease in charge", async () => {
		const r = refs();
		const c = clock();
		await campaign(r, "a", empty, options(c));
		c.advance(LEASE - 1);
		expect(await campaign(r, "b", empty, options(c))).toEqual({ leading: false, term: 1, leader: "a", leaseUntil: 1_000_000 + LEASE });
	});

	it("lets another peer take over once the lease has run out, with the state the old leader left", async () => {
		const r = refs();
		const c = clock();
		const a = await campaign(r, "a", empty, options(c));
		if (!a.leading) throw new Error("a should lead");
		await a.leader.decide(claim("src/x/", "a"));
		c.advance(LEASE + 1);
		const b = await campaign(r, "b", empty, options(c));
		expect(b).toMatchObject({ leading: true, term: 2 });
		if (b.leading) expect(b.leader.state).toEqual({ claims: { "src/x/": "a" } });
	});

	it("hands over at once when the leader resigns", async () => {
		const r = refs();
		const c = clock();
		const a = await campaign(r, "a", empty, options(c));
		if (!a.leading) throw new Error("a should lead");
		await a.leader.resign();
		expect(r.leases.tip()?.commit.kind).toBe("resignation");
		expect(await campaign(r, "b", empty, options(c))).toMatchObject({ leading: true, term: 2 });
	});

	it("re-joins as leader when it already leads under a live lease", async () => {
		const r = refs();
		const c = clock();
		await campaign(r, "a", empty, options(c));
		expect(await campaign(r, "a", empty, options(c))).toMatchObject({ leading: true, term: 1 });
		expect(r.leases.commits).toHaveLength(1);
		expect(r.log.commits).toHaveLength(1);
	});

	it("takes a term above the log's when the lease ref is behind it (lost or reset)", async () => {
		const r = refs();
		const c = clock();
		// The decision log already holds term 5; the lease ref starts empty.
		await r.log.append(null, { term: 5, leader: "old", leaseUntil: 0, kind: "term", entries: [], state: { claims: { "src/x/": "old" } }, batch: "old" });
		const a = await campaign(r, "a", empty, options(c));
		expect(a).toMatchObject({ leading: true, term: 6 });
		if (a.leading) expect(a.leader.state).toEqual({ claims: { "src/x/": "old" } });
		expect(r.log.tip()?.commit).toMatchObject({ kind: "term", term: 6, leader: "a" });
		expect(r.leases.tip()?.commit).toMatchObject({ kind: "election", term: 6, leader: "a" });
		// And it keeps leading on later calls.
		expect(await campaign(r, "a", empty, options(c))).toMatchObject({ leading: true, term: 6 });
	});

	it("stands down if it won the lease but a newer term reached the decision log first", async () => {
		const r = refs();
		const c = clock();
		// a wins the lease, then stalls before writing its term marker; meanwhile its
		// lease runs out and b takes over completely.
		r.log.beforeAppend = async () => {
			c.advance(LEASE + 1);
			r.log.beforeAppend = null;
			const b = await campaign(r, "b", empty, options(c));
			if (!b.leading) throw new Error("b should lead");
		};
		const a = await campaign(r, "a", empty, options(c));
		expect(a).toMatchObject({ leading: false, leader: "b", term: 2 });
		expect(r.log.commits.map((x) => [x.commit.kind, x.commit.term, x.commit.leader])).toEqual([["term", 2, "b"]]);
	});
});

describe("leading", () => {
	async function leader(r: ReturnType<typeof refs>, c: { now: number }, me = "a") {
		const won = await campaign(r, me, empty, options(c));
		if (!won.leading) throw new Error(`${me} should lead`);
		return won.leader;
	}

	it("answers a decision only once it is in the log", async () => {
		const r = refs();
		const a = await leader(r, clock());
		let landed = false;
		r.log.beforeAppend = async () => void (landed = r.log.commits.length > 1);
		expect(await a.decide(claim("src/x/", "a"))).toBe("src/x/");
		expect(landed).toBe(false);
		expect(r.log.decisions()).toEqual(["a claims src/x/"]);
		expect(r.log.tip()?.commit.state).toEqual({ claims: { "src/x/": "a" } });
	});

	it("fences a stale leader: once another peer leads, its decisions never land", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c, "a");
		c.advance(LEASE + 1);
		await leader(r, c, "b");
		await expect(a.decide(claim("src/x/", "a"))).rejects.toEqual(new Deposed("b", 2));
		expect(r.log.decisions()).toEqual([]);
	});

	it("fences a stale leader whose push races the takeover", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c, "a");
		c.advance(LEASE + 1);
		// b's election (lease and term marker) lands between a reading the tip and a's push.
		r.log.beforeAppend = async () => void (await leader(r, c, "b"));
		await expect(a.decide(claim("src/x/", "a"))).rejects.toBeInstanceOf(Deposed);
		expect(r.log.decisions()).toEqual([]);
	});

	it("never loses an acknowledged decision across a takeover", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c, "a");
		await a.decide(claim("src/x/", "a"));
		c.advance(LEASE + 1);
		const b = await leader(r, c, "b");
		await expect(b.decide(claim("src/x/", "b"))).rejects.toThrow(/held by a/);
		expect(await b.decide(claim("src/y/", "b"))).toBe("src/y/");
		expect(r.log.decisions()).toEqual(["a claims src/x/", "b claims src/y/"]);
	});

	it("keeps a lease alive by heartbeating, and the decision log grows only with decisions", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c);
		const logLength = r.log.commits.length;
		for (let i = 0; i < 3; i++) {
			c.advance((LEASE * 2) / 3);
			expect(await a.heartbeat()).toBe(true);
		}
		expect(r.log.commits).toHaveLength(logLength);
		expect(r.leases.tip()?.commit).toMatchObject({ kind: "heartbeat", term: 1, leaseUntil: c.now + LEASE });
		c.advance(LEASE / 2);
		expect(await campaign(r, "b", empty, options(c))).toMatchObject({ leading: false, leader: "a" });
	});

	it("doesn't write to the lease ref when it decides", async () => {
		const r = refs();
		const a = await leader(r, clock());
		const leases = r.leases.commits.length;
		await a.decide(claim("src/x/", "a"));
		expect(r.leases.commits).toHaveLength(leases);
	});

	it("commits decisions that arrive during a push together, in order", async () => {
		const r = refs();
		const a = await leader(r, clock());
		const before = r.log.appends;
		let release!: () => void;
		r.log.beforeAppend = () => new Promise<void>((resolve) => (release = resolve));
		const first = a.decide(claim("p0", "a"));
		const rest = [1, 2, 3, 4].map((i) => a.decide(claim(`p${i}`, "a")));
		await Promise.resolve();
		release();
		expect(await Promise.all([first, ...rest])).toEqual(["p0", "p1", "p2", "p3", "p4"]);
		expect(r.log.appends - before).toBe(2);
		expect(r.log.decisions()).toEqual(["a claims p0", "a claims p1", "a claims p2", "a claims p3", "a claims p4"]);
	});

	it("refuses only the decision that failed, and commits the rest of its batch", async () => {
		const r = refs();
		const a = await leader(r, clock());
		const results = await Promise.allSettled([a.decide(claim("p", "a")), a.decide(claim("p", "b")), a.decide(claim("q", "b"))]);
		expect(results.map((x) => x.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
		expect(r.log.decisions()).toEqual(["a claims p", "b claims q"]);
	});

	it("does not repeat a decision whose push landed but whose acknowledgement was lost", async () => {
		const r = refs();
		const a = await leader(r, clock());
		r.log.loseNextAck = true;
		expect(await a.decide(claim("src/x/", "a"))).toBe("src/x/");
		expect(r.log.decisions()).toEqual(["a claims src/x/"]);
		expect(await a.decide(claim("src/y/", "a"))).toBe("src/y/");
	});

	it("picks up a decision made just after the previous one was answered", async () => {
		const r = refs();
		const a = await leader(r, clock());
		for (let i = 0; i < 5; i++) {
			// Each push takes a few microtasks, as a real one would take time.
			r.log.beforeAppend = async () => {
				await Promise.resolve();
				await Promise.resolve();
			};
			expect(await a.decide(claim(`p${i}`, "a"))).toBe(`p${i}`);
		}
		expect(r.log.decisions()).toHaveLength(5);
	});

	it("renews an idle lease only after two thirds of it has passed", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c);
		c.advance(LEASE / 2);
		expect(await a.heartbeat()).toBe(false);
		c.advance(LEASE / 4);
		expect(await a.heartbeat()).toBe(true);
	});

	it("stands down when its heartbeat finds another peer has taken the lease", async () => {
		const r = refs();
		const c = clock();
		const a = await leader(r, c);
		c.advance(LEASE + 1);
		await leader(r, c, "b");
		await expect(a.heartbeat()).resolves.toBe(false);
		expect(a.leading).toBe(false);
		await expect(a.decide(claim("src/x/", "a"))).rejects.toBeInstanceOf(Deposed);
	});

	it("stops deciding after it resigns", async () => {
		const r = refs();
		const a = await leader(r, clock());
		await a.resign();
		await expect(a.decide(claim("src/x/", "a"))).rejects.toBeInstanceOf(Deposed);
	});
});
