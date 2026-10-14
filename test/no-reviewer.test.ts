import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimRecord } from "../src/toolkit/claims";
import { repoSnapshot } from "../src/toolkit/tools/dashboard";
import {
	agentsAtWork,
	onlyAPersonCanReview,
	otherPeoplesAgents,
	type ReviewState,
} from "../src/toolkit/tools/no-reviewer";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// Where review must be independent, a change waiting for review goes to people's inbox when no one but a person can
// review it: no other person's agent works in the repo, or none is allowed to review. Nothing writes it there; the
// dashboard works it out. By default its own agent reviews it instead, in a fresh context, as status says.

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-no-reviewer-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

const NO_ONE = /^Waiting for review, and no other person's agent works here to review it$/;
const NOT_ALLOWED = /^Waiting for review, and the other people's agents here aren't allowed to review it$/;

describe("a change only a person can review", { timeout: 60_000 }, () => {
	/** Alice's two agents and, once asked, Bob's, sharing repo "p" and stamped as the Worker stamps them. */
	async function aliceAndBob() {
		const told: Record<string, unknown>[] = [];
		const summarize = async (_repo: string, patch: Record<string, unknown>) => void told.push(patch);
		const key = await generateStampKey();
		const as = (person: string) => ({
			identity: person,
			summarize,
			stamper: (agent?: string) => makeStamper(key.privateKey, agent ? `${person}/${agent}` : person),
		});
		const alice = toolCalls(() => server, as("person:alice"));
		const bob = toolCalls(() => server, as("person:bob"));
		await alice.call("settings", { required: 1, independent: true });
		await alice.register("alice-agent", "alice-helper");
		await alice.call(
			"claim",
			{ change: "c1", agent: "alice-agent", paths: ["src/c1/"], intent: "Speed up c1" },
			"alice-agent",
		);
		const head = await pushChange(server.url, work, "alice-agent", "c1", { "src/c1/x.js": "1\n" });
		const attention = async (extra: Parameters<typeof toolCalls>[1] = {}) =>
			(await repoSnapshot({ ...alice.ctx(), ...extra }, "p")).claims[0]!.attention;
		return { alice, bob, head, told, attention };
	}

	it("goes to the inbox when no other person's agent works in the repo, though its own owner has two", async () => {
		const { attention, told } = await aliceAndBob();
		expect(await attention()).toMatchObject({ agent: "githive", reason: expect.stringMatching(NO_ONE) });
		expect(told.at(-1)).toMatchObject({
			needsYou: 1,
			waiting: [{ change: "c1", title: "Speed up c1", reason: expect.stringMatching(NO_ONE) }],
		});
	});

	it("leaves it once another person's agent may review it, and says so while none is allowed to", async () => {
		const { bob, attention } = await aliceAndBob();
		await bob.register("bob-agent");
		expect(await attention()).toBeUndefined();
		const barred = async (agents: string[]) => new Set(agents.filter((agent) => agent === "bob-agent"));
		expect(await attention({ notReviewing: barred })).toMatchObject({ reason: expect.stringMatching(NOT_ALLOWED) });
		// A lookup that fails counts every agent as able, so it sends nothing to the inbox.
		const broken = async () => Promise.reject(new Error("D1 is down"));
		expect(await attention({ notReviewing: broken })).toBeUndefined();
	});

	it("leaves it once the change has its approval", async () => {
		const { bob, head, attention } = await aliceAndBob();
		await bob.register("bob-agent");
		const approve = { commit: head, reviewer: "bob-agent", role: "review", verdict: "approve", evidence: "ran it" };
		await bob.call("vote", approve, "bob-agent");
		expect(await attention({ notReviewing: async () => new Set(["bob-agent"]) })).toBeUndefined();
	});

	it("gives way to its agent's own question, which says more", async () => {
		const { alice, attention } = await aliceAndBob();
		const question = { change: "c1", agent: "alice-agent", reason: "is 64 entries enough?" };
		await alice.call("ask_human", question, "alice-agent");
		expect(await attention()).toMatchObject({ agent: "alice-agent", reason: "is 64 entries enough?" });
	});

	it("counts agents that never register, signed in or GitHive's own, by the claims they hold", async () => {
		const { attention } = await aliceAndBob();
		const key = await generateStampKey();
		const carol = toolCalls(() => server, {
			identity: "person:carol",
			agent: "carol/claude",
			stamper: (agent?: string) => makeStamper(key.privateKey, agent ? `person:carol/${agent}` : "person:carol"),
		});
		const claim = { change: "c9", agent: "carol/claude", paths: ["src/c9/"], intent: "c9" };
		expect(await carol.call("claim", claim)).toMatchObject({ ok: true });
		expect(await attention()).toBeUndefined();
		const barred = async () => new Set(["carol/claude"]);
		expect(await attention({ notReviewing: barred })).toMatchObject({ reason: expect.stringMatching(NOT_ALLOWED) });
	});

	it("by default stays out of the inbox, and leaves the review to its owner's other agent", async () => {
		const { alice, attention } = await aliceAndBob();
		await alice.call("settings", { independent: false });
		expect(await attention()).toBeUndefined();
		const status = await alice.call("status", { change: "c1", agent: "alice-agent" }, "alice-agent");
		expect(status).not.toHaveProperty("reviewYourself");
	});

	it("by default refuses an agent's approval of its own change while its owner's other agent works here", async () => {
		const { alice, head } = await aliceAndBob();
		await alice.call("settings", { independent: false });
		const own = { commit: head, change: "c1", reviewer: "alice-agent", role: "review", verdict: "approve" };
		await expect(alice.call("vote", { ...own, evidence: "ran it" }, "alice-agent")).rejects.toThrow(
			/c1 is your own change, and your owner's other agents work here too \(alice-helper\)/,
		);
		const helper = { ...own, reviewer: "alice-helper", evidence: "ran it" };
		expect(await alice.call("vote", helper, "alice-helper")).toMatchObject({ ok: true });
		const status = await alice.call("status", { change: "c1", agent: "alice-agent" }, "alice-agent");
		expect(status).toMatchObject({ approval: { approved: true, approvals: 1 } });
	});

	it("treats agents registered under one service token as siblings: they review each other, not themselves", async () => {
		const key = await generateStampKey();
		const stamper = (agent?: string) => makeStamper(key.privateKey, agent ? `service:ci/${agent}` : "service:ci");
		const fleet = toolCalls(() => server, { identity: "service:ci", stamper });
		await fleet.call("settings", { required: 1 });
		await fleet.register("agent-1", "agent-2");
		const claim = { change: "c1", agent: "agent-1", paths: ["src/c1/"], intent: "c1" };
		await fleet.call("claim", claim, "agent-1");
		const head = await pushChange(server.url, work, "agent-1", "c1", { "src/c1/x.js": "1\n" });
		const status = () => fleet.call("status", { change: "c1", agent: "agent-1" }, "agent-1");
		expect(await status()).not.toMatchObject({ reviewYourself: true });
		const own = { commit: head, change: "c1", reviewer: "agent-1", role: "review", verdict: "approve" };
		await expect(fleet.call("vote", { ...own, evidence: "ran it" }, "agent-1")).rejects.toThrow(
			/c1 is your own change, and your owner's other agents work here too \(agent-2\)/,
		);
		const sibling = { ...own, reviewer: "agent-2", evidence: "ran it" };
		expect(await fleet.call("vote", sibling, "agent-2")).toMatchObject({ ok: true });
		expect(await status()).toMatchObject({ approval: { approved: true, approvals: 1 } });
	});

	it("by default has a lone agent review its own change in a fresh context, and counts its approval", async () => {
		const key = await generateStampKey();
		const stamper = (agent?: string) => makeStamper(key.privateKey, agent ? `person:alice/${agent}` : "person:alice");
		const alice = toolCalls(() => server, { identity: "person:alice", stamper });
		await alice.call("settings", { required: 1 });
		await alice.register("alice-agent");
		const claim = { change: "c1", agent: "alice-agent", paths: ["src/c1/"], intent: "c1" };
		await alice.call("claim", claim, "alice-agent");
		const head = await pushChange(server.url, work, "alice-agent", "c1", { "src/c1/x.js": "1\n" });
		const status = () => alice.call("status", { change: "c1", agent: "alice-agent" }, "alice-agent");
		expect(await status()).toMatchObject({
			reviewYourself: true,
			next: expect.stringMatching(/^No other agent here may review it, so review it yourself, in a fresh context/),
		});
		const vote = { commit: head, change: "c1", reviewer: "alice-agent", role: "review", verdict: "approve" };
		expect(await alice.call("vote", { ...vote, evidence: "ran its tests" }, "alice-agent")).toMatchObject({ ok: true });
		expect(await status()).toMatchObject({ approval: { approved: true }, next: "Call `merge`." });
	});

	it("doesn't count before anything is pushed", async () => {
		const alice = toolCalls(() => server, { identity: "person:alice" });
		await alice.call("settings", { required: 1 });
		await alice.register("alice-agent");
		await alice.call("claim", { change: "c2", agent: "alice-agent", paths: ["src/c2/"], intent: "c2" }, "alice-agent");
		expect((await repoSnapshot(alice.ctx(), "p")).claims[0]!.attention).toBeUndefined();
	});
});

describe("who else could review a change", () => {
	const claim = { change: "c1", agent: "alice/claude", by: "person:alice" } as ClaimRecord;
	const agent = (name: string, by?: string) => ({ agent: name, keyHash: "", at: "", ...(by ? { by } : {}) });

	it("is another person's agent, or a hive agent of GitHive's, not its own owner's nor GitHive's builder", () => {
		const agents = [
			agent("alice/claude", "person:alice"),
			agent("alice/helper", "person:alice"),
			agent("bob/claude", "person:bob"),
			agent("githive-builder"),
			agent("githive-github"),
			agent("githive-scout", "service:githive-scout"),
			agent("unsigned-agent"),
		];
		expect(otherPeoplesAgents(agents, claim)).toEqual(["bob/claude", "githive-scout", "unsigned-agent"]);
	});

	it("are those holding claims, or registered, giving up a claim or voting lately, once each, people left out", () => {
		const now = Date.parse("2026-10-14T12:00:00Z");
		const lately = "2026-10-14T11:00:00Z";
		const longAgo = "2026-10-13T12:00:00Z";
		const found = agentsAtWork(
			{
				registered: [
					{ agent: "keyed", at: lately },
					{ agent: "keyed-long-ago", at: longAgo },
				],
				claims: [agent("githive-scout", "service:githive-scout"), agent("bob/claude", "person:bob")],
				released: [
					{ agent: "githive-scout", at: lately },
					{ agent: "alice/old", by: "person:alice", at: longAgo },
				],
				votes: [
					{ reviewer: "githive-nurse", by: "service:githive-nurse", at: lately },
					{ reviewer: "person:alice", at: lately },
				],
			},
			now,
		);
		expect(found.map(({ agent: name, by }) => [name, by])).toEqual([
			["githive-scout", "service:githive-scout"],
			["bob/claude", "person:bob"],
			["keyed", undefined],
			["githive-nurse", "service:githive-nurse"],
		]);
	});

	it("counts the other hive agents for a hive agent's own change, as in a demo run", () => {
		const theirs = { change: "help-2", agent: "githive-scout", by: "service:githive-scout" } as ClaimRecord;
		const hive = ["githive-scout", "githive-nurse", "githive-forager"].map((name) => agent(name, `service:${name}`));
		expect(otherPeoplesAgents(hive, theirs)).toEqual(["githive-nurse", "githive-forager"]);
	});

	it("isn't needed while a hosted reviewer is on it, or once it has its approvals", async () => {
		const signs = { active: "", head: "abc", votes: [], approved: false, landing: false, asked: false };
		const waiting: ReviewState = { signs, approval: { approvals: 0, required: 1 }, independent: true };
		const none = async () => new Set<string>();
		expect(await onlyAPersonCanReview(claim, waiting, [], none)).toMatch(NO_ONE);
		// Unless review must be independent, the change's own agent can review it.
		expect(await onlyAPersonCanReview(claim, { ...waiting, independent: false }, [], none)).toBeNull();
		const reviewing = { ...waiting, hosted: { reviewers: [{ role: "review", status: "reviewing" }] } };
		expect(await onlyAPersonCanReview(claim, reviewing, [], none)).toBeNull();
		const failed = { ...waiting, hosted: { reviewers: [{ role: "review", status: "failed" }] } };
		expect(await onlyAPersonCanReview(claim, failed, [], none)).toMatch(NO_ONE);
		const approved = { ...waiting, approval: { approvals: 1, required: 1 } };
		expect(await onlyAPersonCanReview(claim, approved, [], none)).toBeNull();
		const rejection = { verdict: "reject" as const, at: "2026-10-14T00:00:00Z" };
		const rejected = { ...waiting, signs: { ...signs, votes: [rejection] } };
		expect(await onlyAPersonCanReview(claim, rejected, [], none)).toBeNull();
	});
});
