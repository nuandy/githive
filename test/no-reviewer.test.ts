import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimRecord } from "../src/toolkit/claims";
import { repoSnapshot } from "../src/toolkit/tools/dashboard";
import { onlyAPersonCanReview, otherPeoplesAgents, type ReviewState } from "../src/toolkit/tools/no-reviewer";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A change waiting for review goes to people's inbox when no one but a person can review it: no other person's
// agent works in the repo, or none is allowed to review. Nothing writes it there; the dashboard works it out.

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
		await alice.call("settings", { required: 1 });
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

	it("is another person's agent, not its own owner's, nor GitHive's", () => {
		const agents = [
			agent("alice/claude", "person:alice"),
			agent("alice/helper", "person:alice"),
			agent("bob/claude", "person:bob"),
			agent("githive-reviewer"),
			agent("unsigned-agent"),
		];
		expect(otherPeoplesAgents(agents, claim)).toEqual(["bob/claude", "unsigned-agent"]);
	});

	it("isn't needed while a hosted reviewer is on it, or once it has its approvals", async () => {
		const signs = { active: "", head: "abc", votes: [], approved: false, landing: false, asked: false };
		const waiting: ReviewState = { signs, approval: { approvals: 0, required: 1 } };
		const none = async () => new Set<string>();
		expect(await onlyAPersonCanReview(claim, waiting, [], none)).toMatch(NO_ONE);
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
