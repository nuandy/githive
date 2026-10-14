import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLimitStore, type EffortKind, limitsFrom, type OwnerLimits } from "../src/auth/agent-limits";
import { statusOf } from "../src/errors";
import { IdentityStore } from "../src/auth/store";
import { pushChange } from "./helpers/agents";
import { fakeD1 } from "./fakes/d1";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { soakReviews } from "./helpers/soak";
import { toolCalls } from "./helpers/tool-calls";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";

// An agent's owner sets how much of other people's work it does: building their backlog pieces and reviewing their
// changes, both never by default, counted a UTC day at a time. GitHive keeps to it where such
// work starts, and nowhere else.

const DAY = 86_400_000;

async function ownedAgent() {
	const db = fakeD1() as unknown as D1Database;
	const people = new IdentityStore(db);
	await people.invite("ada@example.com", "person:admin");
	const github = { provider: "github" as const, providerId: "1", email: "ada@example.com", name: "Ada", login: "ada" };
	const { user } = (await people.signIn(github)) as { user: { id: string } };
	const agent = await people.createAgent(user.id, "builder");
	let now = Date.parse("2026-10-13T12:00:00Z");
	const limits = new AgentLimitStore(db, () => now);
	return { limits, agent, nextDay: () => (now += DAY) };
}

describe("an agent's limits", () => {
	it("default to building and reviewing nothing of other people's", async () => {
		const { limits, agent } = await ownedAgent();
		expect(await limits.limitsOf(agent.id)).toEqual({ build: 0, review: 0 });
		const its = limits.ownerLimits(agent.id);
		expect(await its.take("build")).toMatch(/^Its owner doesn't let this agent build other people's backlog pieces/);
		expect(await its.take("review")).toMatch(/^Its owner doesn't let this agent review other people's changes/);
		expect(await limits.countsToday([agent.id])).toEqual({ [agent.id]: { build: 0, review: 0 } });
	});

	it("keep no limit where an agent made before the default has it, until its owner changes it", async () => {
		const { limits, agent } = await ownedAgent();
		await limits.setLimits(agent.id, { build: 0, review: null });
		expect(await limits.ownerLimits(agent.id).take("review")).toBeNull();
		await limits.setLimits(agent.id, { build: 0, review: 0 });
		expect(await limits.ownerLimits(agent.id).take("review")).toMatch(/doesn't let this agent review/);
	});

	it("allow up to the number a day, then refuse, and start again the next day", async () => {
		const { limits, agent, nextDay } = await ownedAgent();
		await limits.setLimits(agent.id, { build: 2, review: null });
		const its = limits.ownerLimits(agent.id);
		expect(await its.reached("build")).toBeNull();
		expect([await its.take("build"), await its.take("build")]).toEqual([null, null]);
		expect(await its.take("build")).toMatch(/up to 2 times a day, and it has today/);
		expect(await its.reached("build")).toMatch(/up to 2 times a day/);
		nextDay();
		expect(await its.take("build")).toBeNull();
	});

	it("let only one of two calls take the last one", async () => {
		const { limits, agent } = await ownedAgent();
		await limits.setLimits(agent.id, { build: 1, review: null });
		const its = limits.ownerLimits(agent.id);
		const both = await Promise.all([its.take("build"), its.take("build")]);
		expect(both.filter((refused) => refused === null)).toHaveLength(1);
	});

	it("say which agents may review no other person's change today, for the inbox", async () => {
		const db = fakeD1() as unknown as D1Database;
		const people = new IdentityStore(db);
		await people.invite("ada@example.com", "person:admin");
		const github = {
			provider: "github" as const,
			providerId: "1",
			email: "ada@example.com",
			name: "Ada",
			login: "ada",
		};
		const { user } = (await people.signIn(github)) as { user: { id: string; handle: string } };
		const limits = new AgentLimitStore(db);
		const make = async (name: string, review: number | null) => {
			const agent = await people.createAgent(user.id, name);
			await limits.setLimits(agent.id, { build: 0, review });
			return agent;
		};
		// New, so never; no limit; one a day, unused and used; and revoked.
		await people.createAgent(user.id, "fresh");
		await make("open", null);
		await make("daily", 1);
		const spent = await make("spent", 1);
		await limits.ownerLimits(spent.id).take("review");
		const gone = await make("gone", null);
		await people.revokeAgent(user.id, gone.id);
		const names = ["fresh", "open", "daily", "spent", "gone", "unknown"].map((name) => `${user.handle}/${name}`);
		const barred = await limits.notReviewing([...names, "someone/else"]);
		expect([...barred].sort()).toEqual([`${user.handle}/fresh`, `${user.handle}/gone`, `${user.handle}/spent`]);
	});

	it("are whole numbers a day, 0 for never, or null for no limit", () => {
		const current = { build: 0, review: null };
		expect(limitsFrom({ build: 3 }, current)).toEqual({ build: 3, review: null });
		expect(limitsFrom({ review: 0 }, current)).toEqual({ build: 0, review: 0 });
		for (const bad of [-1, 1.5, "3"]) expect(() => limitsFrom({ build: bad }, current)).toThrow(/whole number a day/);
	});
});

/** Limits kept in memory, as AgentLimitStore keeps them in D1. */
function limitsOf(limit: Record<EffortKind, number | null>): OwnerLimits & { done: Record<EffortKind, number> } {
	const done = { build: 0, review: 0 };
	const reached = async (kind: EffortKind) => {
		const most = limit[kind];
		if (most === null) return null;
		return done[kind] < most ? null : `limit of ${most} ${kind}s reached`;
	};
	return {
		done,
		reached,
		take: async (kind) => {
			const refused = await reached(kind);
			if (!refused) done[kind] += 1;
			return refused;
		},
	};
}

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-limits-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("GitHive's tools, within an owner's limits", { timeout: 60_000 }, () => {
	/** Alice's agent, without limits, and Bob's, within `bobs`: two people sharing the repo. */
	async function twoOwners<Limits extends OwnerLimits>(bobs: Limits) {
		// Review holds kept as the Worker keeps them, since taking a review counts where it places its hold.
		const reviews = soakReviews(server);
		const alice = toolCalls(() => server, { identity: "person:alice", reviews });
		const bob = toolCalls(() => server, { identity: "person:bob", ownerLimits: bobs, reviews });
		await alice.call("settings", { required: 1 });
		await alice.register("alice-agent");
		await bob.register("bob-agent");
		const refusal = (name: string, args: Record<string, unknown>) =>
			bob.call(name, args, "bob-agent").then(
				() => "done",
				(err) => `${statusOf(err).status} ${statusOf(err).message}`,
			);
		return { alice, bob, bobs, refusal };
	}
	const piece = (id: string) => ({ id, title: id, intent: `build ${id}`, paths: [`src/${id}/`] });
	const claim = (agent: string, id: string) => ({ change: id, agent, paths: [`src/${id}/`], intent: id });
	const approve = (commit: string) => ({
		commit,
		reviewer: "bob-agent",
		role: "review",
		verdict: "approve",
		evidence: "ran it",
	});

	it("leave a new agent, at its defaults, building and reviewing none of another person's work", async () => {
		const { limits, agent } = await ownedAgent();
		const { alice, bob, refusal } = await twoOwners(limits.ownerLimits(agent.id));
		await alice.call("add_work", { agent: "alice-agent", items: [piece("a1")] }, "alice-agent");
		await alice.call("claim", claim("alice-agent", "c1"), "alice-agent");
		const head = await pushChange(server.url, work, "alice-agent", "c1", { "src/c1/x.js": "1\n" });

		// Never building theirs: Alice's piece waits, and claiming it is refused and given back.
		const backlog = await bob.call("backlog", { agent: "bob-agent" }, "bob-agent");
		expect(backlog.waiting).toContainEqual({
			id: "a1",
			reason: expect.stringMatching(/^your owner's limit: Its owner doesn't let this agent build/),
		});
		expect(await refusal("claim", claim("bob-agent", "a1"))).toMatch(/^403 Its owner doesn't let this agent build/);
		expect((await alice.call("backlog", { agent: "alice-agent" }, "alice-agent")).open).toContainEqual(
			expect.objectContaining({ id: "a1" }),
		);
		// Its own new work is its own, not another person's.
		expect(await bob.call("claim", claim("bob-agent", "own-idea"), "bob-agent")).toMatchObject({ ok: true });

		// Never reviewing theirs: none offered, and taking Alice's or voting on it is refused.
		expect(await bob.call("reviews", { agent: "bob-agent" }, "bob-agent")).toMatchObject({ reviews: [] });
		const credentials = { change: "c1", agent: "bob-agent" };
		expect(await refusal("credentials", credentials)).toMatch(/^403 Its owner doesn't let this agent review/);
		expect(await refusal("vote", approve(head))).toMatch(/^403 Its owner doesn't let this agent review/);
		const status = await alice.call("status", { change: "c1", agent: "alice-agent" }, "alice-agent");
		expect(status).toMatchObject({ approval: { approved: false, approvals: 0 } });
		expect(await limits.countsToday([agent.id])).toEqual({ [agent.id]: { build: 0, review: 0 } });
	});

	it("lists other people's pieces as waiting, and refuses claiming one, past the building limit", async () => {
		const { alice, bob, bobs, refusal } = await twoOwners(limitsOf({ build: 1, review: null }));
		await alice.call("add_work", { agent: "alice-agent", items: [piece("a1"), piece("a2")] }, "alice-agent");
		await bob.call("add_work", { agent: "bob-agent", ...piece("b1") }, "bob-agent");
		const claim = (id: string) => ({ change: id, agent: "bob-agent", paths: [`src/${id}/`], intent: id });
		expect(await bob.call("claim", claim("a1"), "bob-agent")).toMatchObject({ ok: true });
		// Claiming again renews it, and its own piece and its own new work aren't others' work.
		expect(await bob.call("claim", claim("a1"), "bob-agent")).toMatchObject({ ok: true });
		expect(await bob.call("claim", claim("b1"), "bob-agent")).toMatchObject({ ok: true });
		expect(await bob.call("claim", claim("own-idea"), "bob-agent")).toMatchObject({ ok: true });
		expect(bobs.done.build).toBe(1);
		const backlog = await bob.call("backlog", { agent: "bob-agent" }, "bob-agent");
		expect(backlog.waiting).toContainEqual({ id: "a2", reason: "your owner's limit: limit of 1 builds reached" });
		expect(await refusal("claim", claim("a2"))).toBe("403 limit of 1 builds reached");
		// The refused claim was given back: the piece is free for others.
		expect((await alice.call("backlog", { agent: "alice-agent" }, "alice-agent")).open).toContainEqual(
			expect.objectContaining({ id: "a2" }),
		);
	});

	it("offers no reviews and takes none past the reviewing limit, counting a vote cast without one", async () => {
		const { alice, bob, bobs, refusal } = await twoOwners(limitsOf({ build: 0, review: 1 }));
		for (const change of ["c1", "c2"])
			await alice.call(
				"claim",
				{ change, agent: "alice-agent", paths: [`src/${change}/`], intent: change },
				"alice-agent",
			);
		const head1 = await pushChange(server.url, work, "alice-agent", "c1", { "src/c1/x.js": "1\n" });
		const head2 = await pushChange(server.url, work, "alice-agent", "c2", { "src/c2/x.js": "2\n" });
		// A vote with no review taken first counts too.
		const vote = (commit: string) => ({
			commit,
			reviewer: "bob-agent",
			role: "review",
			verdict: "approve",
			evidence: "ran it",
		});
		expect(await bob.call("vote", vote(head1), "bob-agent")).toMatchObject({ ok: true });
		expect(bobs.done.review).toBe(1);
		expect(await bob.call("reviews", { agent: "bob-agent" }, "bob-agent")).toEqual({
			reviews: [],
			limit: "limit of 1 reviews reached",
			next: expect.stringMatching(/^Your owner's limit leaves you no reviews/),
		});
		expect(await refusal("vote", vote(head2))).toBe("403 limit of 1 reviews reached");
	});

	it("count none of an agent's reviews of its own owner's changes, at the default of never", async () => {
		// Ada's two agents and Bob's, all at the defaults, stamped as the Worker stamps them.
		const key = await generateStampKey();
		const reviews = soakReviews(server);
		const { limits, agent: helper } = await ownedAgent();
		const as = (person: string, ownerLimits?: OwnerLimits) =>
			toolCalls(() => server, {
				identity: person,
				reviews,
				stamper: (name?: string) => makeStamper(key.privateKey, name ? `${person}/${name}` : person),
				...(ownerLimits ? { ownerLimits } : {}),
			});
		const ada = as("person:ada", limits.ownerLimits(helper.id));
		const bob = as("person:bob", limitsOf({ build: 0, review: 0 }));
		await ada.call("settings", { required: 1 });
		await ada.register("ada-builder", "ada-helper");
		await bob.register("bob-agent");
		await ada.call("claim", claim("ada-builder", "c1"), "ada-builder");
		const head = await pushChange(server.url, work, "ada-builder", "c1", { "src/c1/x.js": "1\n" });

		// Ada's helper is offered her change, takes it and approves it; none of it counts against its limit.
		const offered = await ada.call("reviews", { agent: "ada-helper" }, "ada-helper");
		expect(offered).toMatchObject({ reviews: [expect.objectContaining({ change: "c1" })] });
		expect(offered.next).toMatch(/only reviews of their own changes/);
		expect(await ada.call("credentials", { change: "c1", agent: "ada-helper" }, "ada-helper")).toBeTruthy();
		const approve = { commit: head, change: "c1", role: "review", verdict: "approve", evidence: "ran it" };
		expect(await ada.call("vote", { ...approve, reviewer: "ada-helper" }, "ada-helper")).toMatchObject({ ok: true });
		expect(await limits.countsToday([helper.id])).toEqual({ [helper.id]: { build: 0, review: 0 } });

		// Bob's agent, at the same default, still may not review Ada's change.
		expect(await bob.call("reviews", { agent: "bob-agent" }, "bob-agent")).toMatchObject({ reviews: [] });
		await expect(bob.call("vote", { ...approve, reviewer: "bob-agent" }, "bob-agent")).rejects.toThrow(/review/);
	});
});
