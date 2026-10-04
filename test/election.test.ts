import { describe, expect, it } from "vitest";
import { Deposed, type CasLog, type LogCommit, campaign } from "../src/election";

// The elected-coordinator protocol over an in-memory compare-and-swap log.
// Safety comes only from compare-and-swap appends fenced by term; leases and
// clocks only decide when a peer may try to take over.

type State = { claims: Record<string, string> };

/** An in-memory log with Git's push semantics: an append lands only on the tip it was built on. */
class MemoryLog implements CasLog<State> {
	commits: { id: string; parent: string | null; commit: LogCommit<State> }[] = [];
	appends = 0;
	/** Runs before an append lands; lets a test interleave another writer or slow the push. */
	beforeAppend: (() => Promise<void>) | null = null;
	/** Make the next append land but report a network failure, as a lost acknowledgement would. */
	loseNextAck = false;

	tip() {
		return this.commits.at(-1) ?? null;
	}
	async read() {
		const tip = this.tip();
		return tip ? { tip: tip.id, commit: structuredClone(tip.commit) } : null;
	}
	async append(parent: string | null, commit: LogCommit<State>) {
		const hook = this.beforeAppend;
		this.beforeAppend = null;
		await hook?.();
		this.appends++;
		if ((this.tip()?.id ?? null) !== parent) return null;
		const id = `c${this.commits.length + 1}`;
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

/** A decision that claims `path` for `holder`, refused if someone holds it. */
const claim = (path: string, holder: string) => (state: State) => {
	if (state.claims[path]) throw new Error(`[409] ${path} is held by ${state.claims[path]}`);
	return { state: { claims: { ...state.claims, [path]: holder } }, entries: [{ commit: "c0", text: `${holder} claims ${path}`, at: "" }], result: path };
};

describe("campaign", () => {
	it("makes the first peer on an empty log the leader of term 1", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await campaign(log, "a", empty, options(c));
		expect(a).toMatchObject({ leading: true, term: 1 });
		expect(log.tip()?.commit).toMatchObject({ term: 1, leader: "a", kind: "election", leaseUntil: c.now + LEASE });
	});

	it("elects exactly one of two peers campaigning at once", async () => {
		const log = new MemoryLog();
		const c = clock();
		const [a, b] = await Promise.all([campaign(log, "a", empty, options(c)), campaign(log, "b", empty, options(c))]);
		expect([a.leading, b.leading].filter(Boolean)).toHaveLength(1);
		const loser = a.leading ? b : a;
		expect(loser).toMatchObject({ leading: false, term: 1, leader: a.leading ? "a" : "b" });
		expect(log.commits.filter((x) => x.commit.kind === "election")).toHaveLength(1);
	});

	it("leaves a leader with a live lease in charge", async () => {
		const log = new MemoryLog();
		const c = clock();
		await campaign(log, "a", empty, options(c));
		c.advance(LEASE - 1);
		expect(await campaign(log, "b", empty, options(c))).toEqual({ leading: false, term: 1, leader: "a", leaseUntil: 1_000_000 + LEASE });
	});

	it("lets another peer take over once the lease has run out, with the state the old leader left", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await campaign(log, "a", empty, options(c));
		if (!a.leading) throw new Error("a should lead");
		await a.leader.decide(claim("src/x/", "a"));
		c.advance(LEASE + 1);
		const b = await campaign(log, "b", empty, options(c));
		expect(b).toMatchObject({ leading: true, term: 2 });
		if (b.leading) expect(b.leader.state).toEqual({ claims: { "src/x/": "a" } });
	});

	it("hands over at once when the leader resigns", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await campaign(log, "a", empty, options(c));
		if (!a.leading) throw new Error("a should lead");
		await a.leader.resign();
		expect(await campaign(log, "b", empty, options(c))).toMatchObject({ leading: true, term: 2 });
	});

	it("re-joins as leader when it already leads under a live lease", async () => {
		const log = new MemoryLog();
		const c = clock();
		await campaign(log, "a", empty, options(c));
		expect(await campaign(log, "a", empty, options(c))).toMatchObject({ leading: true, term: 1 });
		expect(log.commits).toHaveLength(1);
	});
});

describe("leading", () => {
	async function leader(log: MemoryLog, c: { now: number }, me = "a") {
		const won = await campaign(log, me, empty, options(c));
		if (!won.leading) throw new Error(`${me} should lead`);
		return won.leader;
	}

	it("answers a decision only once it is in the log", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		let landed = false;
		log.beforeAppend = async () => void (landed = log.commits.length > 1);
		expect(await a.decide(claim("src/x/", "a"))).toBe("src/x/");
		expect(landed).toBe(false);
		expect(log.decisions()).toEqual(["a claims src/x/"]);
		expect(log.tip()?.commit.state).toEqual({ claims: { "src/x/": "a" } });
	});

	it("fences a stale leader: once another peer leads, its decisions never land", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await leader(log, c, "a");
		c.advance(LEASE + 1);
		await leader(log, c, "b");
		await expect(a.decide(claim("src/x/", "a"))).rejects.toEqual(new Deposed("b", 2));
		expect(log.decisions()).toEqual([]);
	});

	it("fences a stale leader whose push races the takeover", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await leader(log, c, "a");
		c.advance(LEASE + 1);
		// b's election lands between a reading the tip and a's push.
		log.beforeAppend = async () => void (await leader(log, c, "b"));
		await expect(a.decide(claim("src/x/", "a"))).rejects.toBeInstanceOf(Deposed);
		expect(log.decisions()).toEqual([]);
	});

	it("never loses an acknowledged decision across a takeover", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await leader(log, c, "a");
		await a.decide(claim("src/x/", "a"));
		c.advance(LEASE + 1);
		const b = await leader(log, c, "b");
		await expect(b.decide(claim("src/x/", "b"))).rejects.toThrow(/held by a/);
		expect(await b.decide(claim("src/y/", "b"))).toBe("src/y/");
		expect(log.decisions()).toEqual(["a claims src/x/", "b claims src/y/"]);
	});

	it("keeps renewing its lease while it decides, so a busy leader is not deposed", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await leader(log, c);
		c.advance(LEASE - 1_000);
		await a.decide(claim("src/x/", "a"));
		c.advance(2_000);
		expect(await campaign(log, "b", empty, options(c))).toMatchObject({ leading: false, leader: "a" });
	});

	it("commits decisions that arrive during a push together, in order", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		const before = log.appends;
		let release!: () => void;
		log.beforeAppend = () => new Promise<void>((resolve) => (release = resolve));
		const first = a.decide(claim("p0", "a"));
		const rest = [1, 2, 3, 4].map((i) => a.decide(claim(`p${i}`, "a")));
		await Promise.resolve();
		release();
		expect(await Promise.all([first, ...rest])).toEqual(["p0", "p1", "p2", "p3", "p4"]);
		expect(log.appends - before).toBe(2);
		expect(log.decisions()).toEqual(["a claims p0", "a claims p1", "a claims p2", "a claims p3", "a claims p4"]);
	});

	it("refuses only the decision that failed, and commits the rest of its batch", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		const results = await Promise.allSettled([a.decide(claim("p", "a")), a.decide(claim("p", "b")), a.decide(claim("q", "b"))]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
		expect(log.decisions()).toEqual(["a claims p", "b claims q"]);
	});

	it("does not repeat a decision whose push landed but whose acknowledgement was lost", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		log.loseNextAck = true;
		expect(await a.decide(claim("src/x/", "a"))).toBe("src/x/");
		expect(log.decisions()).toEqual(["a claims src/x/"]);
		expect(await a.decide(claim("src/y/", "a"))).toBe("src/y/");
	});

	it("picks up a decision made just after the previous one was answered", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		for (let i = 0; i < 5; i++) {
			// Each push takes a few microtasks, as a real one would take time.
			log.beforeAppend = async () => {
				await Promise.resolve();
				await Promise.resolve();
			};
			expect(await a.decide(claim(`p${i}`, "a"))).toBe(`p${i}`);
		}
		expect(log.decisions()).toHaveLength(5);
	});

	it("renews an idle lease only after two thirds of it has passed", async () => {
		const log = new MemoryLog();
		const c = clock();
		const a = await leader(log, c);
		c.advance(LEASE / 2);
		expect(await a.heartbeat()).toBe(false);
		c.advance(LEASE / 4);
		expect(await a.heartbeat()).toBe(true);
		expect(log.tip()?.commit).toMatchObject({ kind: "heartbeat", term: 1, leaseUntil: c.now + LEASE });
	});

	it("stops deciding after it resigns", async () => {
		const log = new MemoryLog();
		const a = await leader(log, clock());
		await a.resign();
		await expect(a.decide(claim("src/x/", "a"))).rejects.toBeInstanceOf(Deposed);
	});
});
