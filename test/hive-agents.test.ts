import { describe, expect, it } from "vitest";
import type { HostedAgentState } from "../src/hosted-agents";
import { hiveAgentNames } from "../src/toolkit/hive-agents";
import { FakeStorage } from "./fakes/env";

const { HostedAgent } = await import("../src/hosted-agents");

// GitHive's hosted agents in a repo's hive. Each runs its own loop on its own alarm: its own change, then a review of
// another's under its own name, then the first free piece of the backlog in its own order.

const SIX = 6;

type Piece = { id: string; title: string; intent: string; paths: string[] };
type Offer = { change: string; head: string; role: string };

/**
 * A repo's six hosted agents over a small stand-in for the toolkit: who claims which piece, its head once its builder
 * has pushed, who holds its review, its votes, and what merged. A builder pushes at once; a reviewer votes at once.
 */
function hive(pieces: Piece[], options: { reject?: string[]; takenElsewhere?: string[] } = {}) {
	const claimed = new Map<string, string>();
	const heads = new Map<string, string>();
	const holds = new Map<string, string>();
	const votes = new Map<string, { reviewer: string; verdict: string }[]>();
	const merged = new Set<string>();
	const log: string[] = [];
	const approved = (change: string) =>
		(votes.get(change) ?? []).some((vote) => vote.verdict === "approve" && vote.reviewer !== claimed.get(change));
	const tools = (name: string, args: Record<string, unknown>): unknown => {
		const agent = String(args.agent);
		const change = String(args.change ?? "");
		switch (name) {
			case "status":
				return claimed.has(change)
					? { claim: { agent: claimed.get(change) }, approval: { approved: approved(change) } }
					: {};
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
		protected override async startBuilder(_repo: string, change: string) {
			heads.set(change, `${change}-1`);
			log.push(`builder on ${change}`);
		}
		protected override async startReviewer(_repo: string, offer: Offer, agent: string) {
			const verdict = options.reject?.includes(offer.change) ? "reject" : "approve";
			votes.set(offer.change, [...(votes.get(offer.change) ?? []), { reviewer: agent, verdict }]);
			holds.delete(offer.change);
			log.push(`${agent} reviewed ${offer.change}: ${verdict}`);
		}
		protected override async reviewerDone() {
			return true;
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
	return { repoHive, agents, rounds, log, claimed, merged, votes };
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

describe("starting hosted agents on a repo", () => {
	it("takes a few for a while, and refuses more than a hive holds or too long", async () => {
		const { hiveRequest } = await import("../src/routes/hosted-agents");
		expect(hiveRequest({})).toEqual({ count: 3, minutes: 60 });
		expect(hiveRequest({ count: 12, minutes: 5 })).toEqual({ count: 12, minutes: 5 });
		expect(() => hiveRequest({ count: 13 })).toThrow(/from 1 to 12/);
		expect(() => hiveRequest({ count: 1.5 })).toThrow(/whole number/);
		expect(() => hiveRequest({ minutes: 121 })).toThrow(/from 5 to 120/);
		expect(() => hiveRequest({ minutes: "60" })).toThrow(/minutes/);
	});
});
