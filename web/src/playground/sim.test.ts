import { describe, expect, it } from "vitest";
import type { HiveEvent } from "../api";
import { createSim, DEFAULT_START, EVENTS_KEPT, SCENARIOS, type ScenarioName, type Sim } from "./sim";

// The playground's simulator: deterministic, in the API's shapes, and never stuck.

const MINUTE = 60_000;

/** Whether two claimed entries can hold a common path, as the server tells (a trailing slash is a folder). */
const overlap = (a: string, b: string) => {
	const dirA = a.endsWith("/") ? a : `${a}/`;
	const dirB = b.endsWith("/") ? b : `${b}/`;
	return dirA.startsWith(dirB) || dirB.startsWith(dirA);
};

/** Every event a run emitted, oldest first. The log keeps only the newest, so this gathers them as they come. */
function recorder(sim: Sim) {
	const all: HiveEvent[] = [];
	let seen = 0;
	return {
		all,
		take() {
			const { events } = sim.stats();
			all.push(
				...sim
					.state()
					.events.slice(0, events - seen)
					.reverse(),
			);
			seen = events;
		},
	};
}

/**
 * Runs `sim` to its end, a person approving whatever waits on one whenever nothing else is due, and checks each
 * state on the way. Returns every event, oldest first.
 */
function runToEnd(sim: Sim, most = 5_000) {
	const events = recorder(sim);
	let steps = 0;
	while (!sim.done()) {
		if (++steps > most) throw new Error(`${sim.scenario} didn't finish in ${most} steps`);
		if (sim.nextAt() === null) {
			const waiting = sim.needsPerson();
			// Nothing scheduled and not done: something must be waiting on a person, or the run is stuck.
			expect(waiting).not.toEqual([]);
			for (const change of waiting) sim.personVotes(change, "approve");
		} else sim.step();
		events.take();
		checkState(sim, events.all);
	}
	return events.all;
}

/** What must hold of every state the simulator gives. */
function checkState(sim: Sim, history: HiveEvent[]) {
	const { snapshot, landing, events, tree, backlog, now } = sim.state();
	expect(events.length).toBeLessThanOrEqual(EVENTS_KEPT);
	for (let i = 1; i < events.length; i++)
		expect(Date.parse(events[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(events[i]!.at));
	const pushed = new Set(history.filter((event) => event.kind === "pushed").map((event) => event.commit));
	const ids = snapshot.claims.map((claim) => claim.change);
	expect(new Set(ids).size).toBe(ids.length);
	for (const claim of snapshot.claims) {
		const { approval } = claim;
		if (!claim.head) expect(approval).toMatchObject({ approved: false, approvals: 0 });
		else expect(pushed.has(claim.head)).toBe(true);
		if (approval.approved) {
			expect(approval.approvals).toBeGreaterThanOrEqual(approval.required);
			expect(approval.awaiting ?? []).toEqual([]);
			expect(approval.vetoedBy).toEqual([]);
		}
		if (claim.attention) expect(sim.needsPerson()).toContain(claim.change);
		// Nothing is left waiting on its own agent long enough to count as abandoned.
		if (claim.lease?.freeAfter) expect(Date.parse(claim.lease.freeAfter)).toBeGreaterThan(now);
		// Claims never overlap: each path is held by one change at most.
		for (const other of snapshot.claims)
			if (other !== claim)
				for (const path of claim.paths) for (const held of other.paths) expect(overlap(path, held)).toBe(false);
	}
	const heads = new Map(snapshot.claims.map((claim) => [claim.change, claim.head]));
	for (const checked of landing.checking?.changes ?? []) expect(heads.get(checked.change)).toBe(checked.head);
	for (const vote of snapshot.votes) expect(pushed.has(vote.commit)).toBe(true);
	const landed = new Set(landing.recent.filter((outcome) => outcome.how === "landed").map((outcome) => outcome.change));
	for (const item of backlog) expect(landed.has(item.id)).toBe(false);
	const lastLanded = landing.recent.filter((outcome) => outcome.how === "landed").at(-1);
	if (lastLanded) expect(tree.commit).toBe(lastLanded.commit);
}

const run = (scenario: ScenarioName, seed: number) => {
	const sim = createSim(scenario, seed);
	return { sim, events: runToEnd(sim) };
};

const minutesIn = (event: HiveEvent) => (Date.parse(event.at) - DEFAULT_START) / MINUTE;

describe("the playground's simulator", () => {
	it("plays the same hive for the same scenario and seed", () => {
		const a = run("mixed", 7);
		const b = run("mixed", 7);
		expect(b.events).toEqual(a.events);
		expect(b.sim.state()).toEqual(a.sim.state());
		const other = run("mixed", 8);
		expect(other.events).not.toEqual(a.events);
	});

	it("starts its clock where it's told, and at a fixed time otherwise", () => {
		expect(createSim("mixed", 1).state().now).toBe(DEFAULT_START);
		const start = Date.UTC(2030, 0, 1);
		const sim = createSim("mixed", 1, start);
		sim.advance(5 * MINUTE);
		expect(sim.state().now).toBe(start + 5 * MINUTE);
		expect(sim.state().events.every((event) => Date.parse(event.at) >= start)).toBe(true);
	});

	it.each(SCENARIOS.map((scenario) => scenario.name))("runs %s to its end with nothing stuck", (scenario) => {
		for (const seed of [1, 2, 3]) {
			const { sim, events } = run(scenario, seed);
			const { snapshot, landing, backlog } = sim.state();
			expect(snapshot.claims).toEqual([]);
			expect(landing.checking).toBeNull();
			expect(backlog).toEqual([]);
			expect(sim.nextAt()).toBeNull();
			expect(events.some((event) => event.kind === "landed")).toBe(true);
		}
	});

	it("keeps at most 100 events, newest first", () => {
		const { sim, events } = run("swarm", 1);
		expect(events.length).toBeGreaterThan(EVENTS_KEPT);
		const kept = sim.state().events;
		expect(kept).toHaveLength(EVENTS_KEPT);
		expect(kept).toEqual(events.slice(-EVENTS_KEPT).reverse());
	});

	it("names only the change in a push, and only the commit in a vote", () => {
		const { events } = run("mixed", 2);
		const pushes = events.filter((event) => event.kind === "pushed");
		expect(pushes.length).toBeGreaterThan(0);
		for (const push of pushes) {
			expect(push.agent).toBeUndefined();
			expect(push.change).toBeTruthy();
			expect(push.commit).toMatch(/^[0-9a-f]{40}$/);
		}
		for (const vote of events.filter((event) => event.kind === "voted")) {
			expect(vote.change).toBeUndefined();
			expect(vote).toMatchObject({ agent: expect.any(String), commit: expect.any(String), detail: expect.any(String) });
		}
	});

	it("drops a landed change's claim, and its landed event names its agent and change", () => {
		const sim = createSim("mixed", 3);
		const events = recorder(sim);
		let landings = 0;
		while (!sim.done()) {
			if (sim.nextAt() === null) for (const change of sim.needsPerson()) sim.personVotes(change, "approve");
			else sim.step();
			const before = events.all.length;
			events.take();
			const { snapshot, landing, tree } = sim.state();
			for (const event of events.all.slice(before).filter((each) => each.kind === "landed")) {
				landings++;
				expect(event).toMatchObject({ agent: expect.any(String), change: expect.any(String) });
				expect(snapshot.claims.map((claim) => claim.change)).not.toContain(event.change);
				expect(landing.recent).toContainEqual(
					expect.objectContaining({ change: event.change, agent: event.agent, how: "landed", commit: event.commit }),
				);
				// A released item can be claimed again by someone else: the claim that landed is the last one.
				const claimed = events.all.findLast((each) => each.kind === "claimed" && each.change === event.change);
				expect(claimed?.agent).toBe(event.agent);
				expect(tree.files.length).toBeGreaterThan(0);
			}
		}
		expect(landings).toBe(sim.state().landing.stretch?.landed);
	});

	it("puts a failed change back to its agent with a rejection from the checks, and lands it once fixed", () => {
		const sim = createSim("mixed", 4);
		const events = runToEnd(sim);
		const failed = events.find((event) => event.kind === "failed");
		expect(failed).toMatchObject({ agent: expect.any(String), change: expect.any(String), detail: expect.any(String) });
		const outcome = sim.state().landing.recent.find((each) => each.how === "failed");
		expect(outcome).toMatchObject({ change: failed!.change, head: failed!.commit, reasons: [failed!.detail] });
		const after = events.slice(events.indexOf(failed!));
		expect(after.find((event) => event.kind === "pushed" && event.change === failed!.change)).toBeTruthy();
		expect(after.find((event) => event.kind === "landed" && event.change === failed!.change)).toBeTruthy();
	});

	it("waits on a person, and the person's vote unblocks the change", () => {
		const sim = createSim("mixed", 5);
		sim.advance(20 * MINUTE);
		expect(sim.needsPerson()).toEqual(expect.arrayContaining(["bump-qs", "layer-regexp-cache"]));
		const deps = sim.state().snapshot.claims.find((claim) => claim.change === "bump-qs")!;
		expect(deps.approval).toMatchObject({ approved: false, awaiting: ["security"] });
		// Ten minutes unheld, GitHive flags the security review for people, and the change waits on one.
		expect(deps.attention?.agent).toBe("githive");
		expect(deps.lease?.waitingOn).toBe("person");

		sim.personVotes("bump-qs", "approve");
		expect(sim.needsPerson()).not.toContain("bump-qs");
		const approved = sim.state().snapshot.claims.find((claim) => claim.change === "bump-qs")!;
		expect(approved.approval).toMatchObject({ approved: true, awaiting: [] });
		expect(approved.attention).toBeUndefined();
		expect(sim.state().snapshot.votes[0]).toMatchObject({
			role: "security",
			verdict: "approve",
			by: "person:5c1e9a7b20d4",
		});

		// A person turning the asked question down sends the change back; its agent pushes again and it lands.
		sim.personVotes("layer-regexp-cache", "reject");
		expect(sim.needsPerson()).not.toContain("layer-regexp-cache");
		const events = runToEnd(sim);
		const landed = (change: string) => events.some((event) => event.kind === "landed" && event.change === change);
		expect(landed("bump-qs")).toBe(true);
		expect(landed("layer-regexp-cache")).toBe(true);
		expect(events.some((event) => event.kind === "pushed" && event.change === "layer-regexp-cache")).toBe(true);
	});

	it("gives a change up once it's been sent back three times", () => {
		const sim = createSim("mixed", 1);
		sim.advance(20 * MINUTE);
		const events = recorder(sim);
		let rejected = 0;
		while (sim.state().snapshot.claims.some((claim) => claim.change === "bump-qs")) {
			if (sim.needsPerson().includes("bump-qs")) {
				sim.personVotes("bump-qs", "reject");
				rejected++;
			} else sim.step();
			events.take();
		}
		expect(rejected).toBe(3);
		const released = events.all.find((event) => event.kind === "released" && event.change === "bump-qs");
		expect(released).toMatchObject({ agent: "carol-claude", detail: expect.stringContaining("Sent back 3 times") });
	});

	it("records no event for a refused claim", () => {
		const { sim, events } = run("swarm", 2);
		const { refused } = sim.stats();
		expect(refused.length).toBeGreaterThan(0);
		for (const refusal of refused) {
			const at = new Date(refusal.at).toISOString();
			expect(events).not.toContainEqual(
				expect.objectContaining({ kind: "claimed", agent: refusal.agent, change: refusal.change, at }),
			);
		}
		// Exactly one agent wins each item: each change is claimed by one agent.
		const winners = new Map<string, Set<string>>();
		for (const event of events.filter((each) => each.kind === "claimed"))
			winners.set(event.change!, (winners.get(event.change!) ?? new Set()).add(event.agent!));
		for (const agents of winners.values()) expect(agents.size).toBe(1);
	});

	it("lands all 27 of the swarm's items", () => {
		const { sim, events } = run("swarm", 3);
		const landed = new Set(events.filter((event) => event.kind === "landed").map((event) => event.change));
		expect(landed.size).toBe(27);
		expect(sim.state().tree.files.filter((file) => file.endsWith(".edges.js"))).toHaveLength(27);
	});

	it("tells the mixed hive's stories in its first twenty minutes or so", () => {
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			const sim = createSim("mixed", seed);
			const events = recorder(sim);
			sim.advance(23 * MINUTE);
			events.take();
			const early = events.all.filter((event) => minutesIn(event) <= 23);
			const kinds = new Set(early.map((event) => event.kind));
			for (const kind of ["asked", "released", "failed", "heads_up", "building", "merging"] as const)
				expect(kinds, `seed ${seed}: ${kind}`).toContain(kind);
			// The rejected fix: rejected, pushed again, landed.
			const rejected = early.find((event) => event.kind === "voted" && event.verdict === "reject");
			expect(rejected, `seed ${seed}: a rejection`).toBeTruthy();
			const fix = early.filter((event) => event.change === "fix-ipv6-host");
			expect(fix.filter((event) => event.kind === "pushed")).toHaveLength(2);
			expect(fix.some((event) => event.kind === "landed")).toBe(true);
			// The failed batch's change, fixed and landed.
			const failed = early.find((event) => event.kind === "failed")!;
			expect(early.some((event) => event.kind === "landed" && event.change === failed.change)).toBe(true);
			// Two agents reached for the same item at once; one won.
			expect(sim.stats().refused).toContainEqual(expect.objectContaining({ agent: "agent-12", change: "etag-weak" }));
			expect(sim.needsPerson()).toContain("bump-qs");
		}
	});

	it("frees a released item for someone else", () => {
		const { events } = run("mixed", 1);
		const released = events.find((event) => event.kind === "released")!;
		const again = events.find(
			(event) => event.kind === "claimed" && event.change === released.change && event.agent !== released.agent,
		);
		expect(again).toBeTruthy();
		expect(events.some((event) => event.kind === "landed" && event.change === released.change)).toBe(true);
	});

	it("opens the first-agent hive empty, until its agent arrives", () => {
		const sim = createSim("first-agent", 1);
		expect(sim.state().snapshot.claims).toEqual([]);
		expect(sim.state().events).toEqual([]);
		expect(sim.state().landing.stretch).toBeUndefined();
		sim.advance(25_000);
		expect(sim.state().events).toEqual([]);
		sim.advance(30_000);
		expect(sim.state().snapshot.claims).toHaveLength(1);
	});

	it("leaves three quiet hours between the quiet-burst's bursts, which a step skips", () => {
		const sim = createSim("quiet-burst", 1);
		while (sim.state().snapshot.claims.length || !sim.state().landing.stretch) sim.step();
		expect(sim.state().landing.stretch?.landed).toBe(4);
		// Agents look for more work after landing, and find none.
		while ((sim.nextAt() ?? Infinity) - sim.state().now < 30 * MINUTE) sim.step();
		const quietFrom = sim.state().now;
		expect(sim.state().snapshot.claims).toEqual([]);
		sim.step();
		expect(sim.state().now - quietFrom).toBeGreaterThan(2.5 * 60 * MINUTE);
		runToEnd(sim);
		// The second burst is a stretch of its own.
		expect(sim.state().landing.stretch?.landed).toBe(3);
	});

	it("works on about 2,000 files in the big repo", () => {
		const sim = createSim("big-repo", 1);
		const files = sim.state().tree.files.length;
		expect(files).toBeGreaterThan(1_800);
		expect(files).toBeLessThan(2_200);
		sim.advance(8 * MINUTE);
		const folders = new Set(
			sim.state().snapshot.claims.map((claim) => claim.paths[0]!.split("/").slice(0, 2).join("/")),
		);
		expect(folders.size).toBeGreaterThanOrEqual(8);
	});

	it("gives the same parts back until something changes", () => {
		const sim = createSim("mixed", 1);
		sim.advance(3 * MINUTE);
		const first = sim.state();
		const again = sim.state();
		expect(again.snapshot).toBe(first.snapshot);
		expect(again.tree).toBe(first.tree);
		sim.step();
		const after = sim.state();
		expect(after.snapshot).not.toBe(first.snapshot);
		expect(after.now).toBeGreaterThan(first.now);
	});

	it("ignores a person's vote on a change that isn't waiting for one", () => {
		const sim = createSim("mixed", 1);
		sim.advance(6 * MINUTE);
		const before = JSON.stringify(sim.state().snapshot);
		sim.personVotes("fix-ipv6-host", "approve");
		sim.personVotes("no-such-change", "reject");
		expect(JSON.stringify(sim.state().snapshot)).toBe(before);
	});
});
