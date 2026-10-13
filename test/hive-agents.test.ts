import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_FALLBACK_MS, AGENT_TURN_GAP_MS, type HostedAgentState } from "../src/hosted-agents";
import { hiveAgentNames } from "../src/toolkit/hive-agents";
import { FakeStorage } from "./fakes/env";

const { HostedAgent } = await import("../src/hosted-agents");

// GitHive's hosted agents in a repo's hive. Each runs its own loop on its own alarm: its own change, then a review of
// another's under its own name, then the first free piece of the backlog in its own order.

const SIX = 6;

type Piece = { id: string; title: string; intent: string; paths: string[]; landsAfter?: string[] };
type Offer = { change: string; head: string; role: string };

/**
 * A repo's six hosted agents over a small stand-in for the toolkit: who claims which piece, its head once its builder
 * has pushed, who holds its review, its votes, and what merged. A builder pushes at once; a reviewer votes at once.
 */
interface HiveOptions {
	reject?: string[];
	takenElsewhere?: string[];
	stalls?: string[];
	/** Claims of these are written, then the call fails, once each: a busy store answering an error after a write. */
	failAfterWrite?: string[];
	/** Claims of these are refused once each, leaving the claim behind, as a claim refused partway in shards can. */
	refusedPartway?: string[];
	/** Claims already in an agent's name, by change, that the agent doesn't know it holds. */
	strays?: Record<string, string>;
	/** Changes whose status misses their claim once, as a read of claims spread over records briefly can. */
	statusMisses?: string[];
	/** Changes GitHive's builder is still at. */
	building?: string[];
}

function hive(pieces: Piece[], options: HiveOptions = {}) {
	const claimed = new Map<string, string>(Object.entries(options.strays ?? {}));
	const heads = new Map<string, string>();
	const holds = new Map<string, string>();
	const votes = new Map<string, { reviewer: string; verdict: string }[]>();
	const merged = new Set<string>();
	const log: string[] = [];
	const claimedAfter = new Map<string, string[]>();
	const givenBack = new Set<string>();
	const rechecks: string[] = [];
	const approved = (change: string) =>
		(votes.get(change) ?? []).some((vote) => vote.verdict === "approve" && vote.reviewer !== claimed.get(change));
	const happened = new Set<string>();
	const once = (list: string[] | undefined, key: string) => {
		const change = key.replace(/^status:/, "");
		if (!list?.includes(change)) return false;
		if (happened.has(key)) return false;
		happened.add(key);
		return true;
	};
	const tools = (name: string, args: Record<string, unknown>): unknown => {
		const agent = String(args.agent);
		const change = String(args.change ?? "");
		switch (name) {
			case "status":
				if (once(options.statusMisses, `status:${change}`)) return {};
				return claimed.has(change)
					? {
							claim: { agent: claimed.get(change) },
							head: heads.get(change) ?? null,
							approval: { approved: approved(change) },
						}
					: {};
			case "claims":
				return [...claimed].map(([held, holder]) => ({ change: held, agent: holder }));
			case "merge":
				if (!approved(change)) return { ok: false };
				claimed.delete(change);
				merged.add(change);
				log.push(`${agent} merged ${change}`);
				return { ok: true };
			case "reviews": {
				const offers: Offer[] = [...heads]
					.filter(([piece]) => claimed.has(piece) && claimed.get(piece) !== agent && !holds.has(piece))
					.filter(([piece]) => !approved(piece))
					.map(([piece, head]) => ({ change: piece, head, role: "review" }));
				return { reviews: offers };
			}
			case "credentials":
				if (options.takenElsewhere?.includes(change))
					throw new Error(`[409] ${change} is already being reviewed by githive-other: take another from reviews`);
				holds.set(change, agent);
				return { url: "u", token: "t" };
			case "backlog": {
				const free = pieces.filter((piece) => !claimed.has(piece.id) && !merged.has(piece.id));
				const turn = hiveAgentNames(SIX).indexOf(agent) % Math.max(1, free.length);
				const waiting = [...claimed.keys()].map((id) => ({ id, reason: "claimed" }));
				return { open: [...free.slice(turn), ...free.slice(0, turn)], waiting };
			}
			case "claim":
				if (claimed.has(change)) return { ok: false };
				claimed.set(change, agent);
				if (once(options.failAfterWrite, change)) throw new Error("[500] the store is busy");
				if (once(options.refusedPartway, change)) return { ok: false, conflicts: [], stillHeld: [change] };
				if (args.after) claimedAfter.set(change, args.after as string[]);
				return { ok: true };
			case "release":
				claimed.delete(change);
				return {};
		}
		throw new Error(`no ${name} here`);
	};
	const instances = new Map<string, InstanceType<typeof HostedAgent>>();
	class TestAgent extends HostedAgent {
		protected override async callTool(name: string, args: Record<string, unknown>) {
			return tools(name, args);
		}
		protected override async buildersAtWork(_repo: string, changes: string[]) {
			return new Set(changes.filter((change) => options.building?.includes(change)));
		}
		protected override async startBuilder(_repo: string, change: string) {
			heads.set(change, `${change}-1`);
			log.push(`builder on ${change}`);
		}
		protected override async startReviewer(_repo: string, offer: Offer, agent: string, earlier?: { head: string }) {
			if (earlier) rechecks.push(`${agent} ${offer.change} after ${earlier.head}`);
			const verdict = options.reject?.includes(offer.change) ? "reject" : "approve";
			votes.set(offer.change, [...(votes.get(offer.change) ?? []), { reviewer: agent, verdict }]);
			holds.delete(offer.change);
			log.push(`${agent} reviewed ${offer.change}: ${verdict}`);
		}
		protected override async reviewerResult(_repo: string, reviewing: { change: string }) {
			const over = !options.stalls?.includes(reviewing.change);
			return options.reject?.includes(reviewing.change) ? { over, rejected: `${reviewing.change} is wrong` } : { over };
		}
		protected override async stillHolds(_repo: string, reviewing: { change: string }) {
			return !givenBack.has(reviewing.change);
		}
		protected override agentNamed(repo: string, name: string): InstanceType<typeof HostedAgent> {
			return instanceFor(`agent:${repo}:${name}`);
		}
	}
	function instanceFor(name: string): InstanceType<typeof HostedAgent> {
		let instance = instances.get(name);
		if (!instance) {
			instance = new TestAgent({ storage: new FakeStorage() } as never, {} as never);
			instances.set(name, instance);
		}
		return instance;
	}
	const repoHive = instanceFor("hive:ada--honeycomb");
	const agents = () => hiveAgentNames(SIX).map((name) => instanceFor(`agent:ada--honeycomb:${name}`));
	/** Each agent takes `turns` turns, in step: every agent's alarm once a round. */
	const rounds = async (turns: number) => {
		for (let round = 0; round < turns; round++) for (const agent of agents()) await agent.alarm();
	};
	return { repoHive, agents, rounds, log, claimed, merged, votes, claimedAfter, givenBack, rechecks, heads };
}

const pieces = (...ids: string[]) => ids.map((id) => ({ id, title: id, intent: `build ${id}`, paths: [`src/${id}/`] }));
const start = (repoHive: InstanceType<typeof HostedAgent>, minutes = 45) =>
	repoHive.start({ repo: "ada--honeycomb", count: SIX, minutes, by: "ada" });

describe("a repo's hosted agents", () => {
	it("each take a piece of their own, review one another's under their own names, and merge their own", async () => {
		const { repoHive, rounds, merged, votes, claimed } = hive(pieces("a", "b", "c"));
		await start(repoHive);
		await rounds(6);
		expect([...merged].sort()).toEqual(["a", "b", "c"]);
		expect(claimed.size).toBe(0);
		// Every change was reviewed by an agent other than the one that built it.
		for (const piece of ["a", "b", "c"]) expect(votes.get(piece)?.[0]?.reviewer).toMatch(/^githive-/);
		const status = await repoHive.status();
		expect(status?.working).toBe(false);
		expect(status?.agents).toHaveLength(SIX);
	});

	it("review before taking more of the backlog", async () => {
		const { repoHive, agents, rounds, log } = hive(pieces("a", "b"));
		await start(repoHive);
		await rounds(1);
		// The first round, two agents took the two pieces; an idle agent's next turn reviews rather than waits.
		expect(log.some((line) => line.includes("reviewed"))).toBe(true);
		const accounts = await Promise.all(agents().map((agent) => agent.account()));
		expect(accounts.filter((account) => account?.change)).toHaveLength(2);
	});

	it("pass over a review another agent took meanwhile, without counting it a failed turn", async () => {
		const { repoHive, agents, rounds, log, merged } = hive(pieces("a", "b"), { takenElsewhere: ["a"] });
		await start(repoHive);
		await rounds(3);
		expect(log.some((line) => line.includes("reviewed a"))).toBe(false);
		expect(merged.has("b")).toBe(true);
		const accounts = (await Promise.all(agents().map((agent) => agent.account()))) as HostedAgentState[];
		expect(accounts.every((account) => account.failing === 0)).toBe(true);
	});

	it("stay stopped when told to stop in the middle of a turn", async () => {
		const { repoHive, agents } = hive(pieces("a"));
		await start(repoHive);
		const [first] = agents();
		// The stop lands while the agent's turn waits on its first toolkit call.
		const turn = first!.alarm();
		await first!.stop();
		await turn;
		expect(((await first!.account()) as HostedAgentState).done).toBe(true);
	});

	it("give back a claim that failed partway, so the piece isn't left claimed with nobody building it", async () => {
		const { repoHive, rounds, log, merged } = hive(pieces("a", "b"), { failAfterWrite: ["a"], refusedPartway: ["b"] });
		await start(repoHive);
		await rounds(6);
		expect(log).toEqual(expect.arrayContaining(["builder on a", "builder on b"]));
		expect(merged).toEqual(new Set(["a", "b"]));
	});

	it("give back a claim in their name they don't know they hold, unless a builder is at it", async () => {
		const strays = { a: "githive-forager", b: "githive-scout" };
		const { repoHive, rounds, log, merged } = hive(pieces("a", "b"), { strays, building: ["b"] });
		await start(repoHive);
		await rounds(1);
		// a, with nothing pushed and no builder, is free again and built; b's builder is still at it, so it stays.
		expect(log).toContain("builder on a");
		expect(log).not.toContain("builder on b");
		await rounds(5);
		expect(merged.has("a")).toBe(true);
	});

	it("keep their change when a read briefly misses its claim while its builder is at it", async () => {
		const { repoHive, rounds, log, merged } = hive(pieces("a"), { statusMisses: ["a"], building: ["a"] });
		await start(repoHive);
		await rounds(6);
		expect(log.filter((line) => line === "builder on a")).toHaveLength(1);
		expect(merged.has("a")).toBe(true);
	});

	it("claim a piece that lands after others with them as after, so it's built alongside them", async () => {
		const wiring = { id: "app", title: "app", intent: "wire", paths: ["src/main.js"], landsAfter: ["a"] };
		const { repoHive, rounds, claimedAfter } = hive([...pieces("a"), wiring]);
		await start(repoHive);
		await rounds(1);
		expect(claimedAfter.get("app")).toEqual(["a"]);
	});

	it("wait on a review while they hold it, and move on once their hold is gone", async () => {
		const { repoHive, agents, rounds, givenBack } = hive(pieces("a"), { stalls: ["a"] });
		await start(repoHive);
		await rounds(2);
		const reviewing = async () => {
			const accounts = await Promise.all(agents().map((agent) => agent.account()));
			return accounts.filter((account) => account?.reviewing).map((account) => account!.reviewing!.change);
		};
		// Its reviewer hasn't voted, and it still holds the review: however long that takes, it waits.
		expect(await reviewing()).toEqual(["a"]);
		// The reviewer failed and gave the review back (or the hold ran out): the agent goes on.
		givenBack.add("a");
		await rounds(1);
		expect(await reviewing()).toEqual([]);
	});

	it("review first the revision of a change they rejected, given what they found", async () => {
		const { repoHive, agents, rounds, rechecks, heads } = hive(pieces("a"), { reject: ["a"] });
		await start(repoHive);
		await rounds(2);
		const reviewer = (await Promise.all(agents().map((agent) => agent.account()))).find((a) => a?.rejected?.length);
		expect(reviewer?.rejected).toEqual([{ change: "a", head: "a-1", findings: "a is wrong" }]);
		// Its builder pushes a revision: the agent that rejected it reviews it next, checking its findings.
		heads.set("a", "a-2");
		await rounds(1);
		expect(rechecks).toContain(`${reviewer!.name} a after a-1`);
	});

	it("take no new work once their time is up, and stop when told", async () => {
		const { repoHive, agents, rounds, claimed } = hive(pieces("a"), { reject: ["a"] });
		await start(repoHive, 0);
		await rounds(1);
		expect(claimed.size).toBe(0);
		await start(repoHive);
		await rounds(2);
		expect(claimed.size).toBe(1);
		await repoHive.stopAll();
		const accounts = (await Promise.all(agents().map((agent) => agent.account()))) as HostedAgentState[];
		expect(accounts.every((account) => account.done)).toBe(true);
	});
});

type Agent = InstanceType<typeof HostedAgent>;
const storageOf = (agent: Agent) => (agent as unknown as { ctx: { storage: FakeStorage } }).ctx.storage;
const alarmOf = (agent: Agent) => storageOf(agent).getAlarm();

describe("ringing a repo's hosted agents", () => {
	// Time stands still, so a ring and the turn it lands in share a moment.
	const now = Date.parse("2026-10-13T10:00:00Z");
	afterEach(() => vi.useRealTimers());
	const frozen = () => vi.useFakeTimers({ now, toFake: ["Date"] });

	it("wait to be rung between turns, then take a turn soon, at most one per gap", async () => {
		frozen();
		const { repoHive, agents } = hive(pieces("a", "b"));
		await start(repoHive);
		const [first] = agents();
		await first!.alarm();
		expect(await alarmOf(first!)).toBe(now + AGENT_FALLBACK_MS);
		expect(await first!.ring("release")).toBe(true);
		expect(await alarmOf(first!)).toBe(now + AGENT_TURN_GAP_MS);
		vi.setSystemTime(now + 60_000);
		await first!.ring("landed");
		expect(await alarmOf(first!)).toBe(now + AGENT_TURN_GAP_MS);
	});

	it("take the next turn soon when rung during one, since its reads may have come too early", async () => {
		frozen();
		const { repoHive, agents } = hive(pieces("a"));
		await start(repoHive);
		const [first] = agents();
		const turn = first!.alarm();
		await first!.ring("vote");
		await turn;
		expect(await alarmOf(first!)).toBe(now + AGENT_TURN_GAP_MS);
	});

	it("skip rings that may offer work while busy with their own change and a review, but not one about them", async () => {
		frozen();
		const { repoHive, agents } = hive(pieces("a"));
		await start(repoHive);
		const [first] = agents();
		const busy = { change: "a", reviewing: { change: "b", head: "b-1", role: "review", since: now } };
		const state = (await first!.account()) as HostedAgentState;
		await storageOf(first!).put("agent", { ...state, ...busy });
		await storageOf(first!).setAlarm(now + AGENT_FALLBACK_MS);
		await first!.ring({ reason: "claim", for: [] });
		await first!.ring({ reason: "pushed", opens: true });
		await first!.ring({ reason: "vote", for: ["someone-else"] });
		expect(await alarmOf(first!)).toBe(now + AGENT_FALLBACK_MS);
		// Its reviewer giving the review back ends its wait, as a vote does: both name it.
		await first!.ring({ reason: "leave_review", for: [state.name], opens: true });
		expect(await alarmOf(first!)).toBe(now);
	});

	it("wake when idle for a ring that may offer work, and never for one about other agents alone", async () => {
		frozen();
		const { repoHive, agents } = hive(pieces("a"));
		await start(repoHive);
		const [first] = agents();
		await first!.alarm();
		await first!.ring({ reason: "vote", for: ["someone-else"] });
		await first!.ring({ reason: "claim", for: [] });
		expect(await alarmOf(first!)).toBe(now + AGENT_FALLBACK_MS);
		await first!.ring({ reason: "add_work", opens: true });
		expect(await alarmOf(first!)).toBe(now + AGENT_TURN_GAP_MS);
	});

	it("never wake once stopped, and the hive says when none of its agents is running", async () => {
		const { repoHive, agents } = hive(pieces("a"));
		await start(repoHive);
		expect(await repoHive.ringAgents("claim")).toBe(true);
		await repoHive.stopAll();
		expect(await repoHive.ringAgents("claim")).toBe(false);
		for (const agent of agents()) expect(await alarmOf(agent)).toBeNull();
	});
});

describe("starting hosted agents on a repo", () => {
	it("takes a few for a while, and refuses more than a hive holds or too long", async () => {
		const { hiveRequest } = await import("../src/routes/hosted-agents");
		expect(hiveRequest({})).toEqual({ count: 3, minutes: 60 });
		expect(hiveRequest({ count: 13, minutes: 5 })).toEqual({ count: 13, minutes: 5 });
		expect(() => hiveRequest({ count: 14 })).toThrow(/from 1 to 13/);
		expect(() => hiveRequest({ count: 1.5 })).toThrow(/whole number/);
		expect(() => hiveRequest({ minutes: 121 })).toThrow(/from 5 to 120/);
		expect(() => hiveRequest({ minutes: "60" })).toThrow(/minutes/);
	});
});
