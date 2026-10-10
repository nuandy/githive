import { describe, expect, it } from "vitest";
import {
	approval,
	effectivePolicy,
	grantWarnings,
	holdsRole,
	openFlag,
	vote,
	type VoteRecord,
	type Votes,
} from "../src/toolkit/votes";
import { MemoryLog } from "./helpers/memory-log";

// Review: reviewers append verdicts on the exact commit they
// reviewed; a merging agent counts them itself, under the task's policy.

const policy = { required: 2, vetoes: ["security"], grants: { security: ["rev-2", "rev-3"] } };
const head = "h1";

describe("votes", () => {
	it("approves a commit with the required approvals and no veto", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "tests pass" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "security", verdict: "approve", evidence: "no secrets" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({
			approved: true,
			approvals: 2,
			vetoedBy: [],
			awaiting: [],
		});
	});

	it("waits for every veto role, however many others approve", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "tests pass" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "api is fine" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({
			approved: false,
			approvals: 2,
			vetoedBy: [],
			awaiting: ["security"],
		});
	});

	it("blocks a merge on a veto, whatever the approvals", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "ok" });
		await vote(log, {
			commit: head,
			reviewer: "rev-3",
			role: "security",
			verdict: "reject",
			evidence: "leaks a token",
		});
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({
			approved: false,
			approvals: 2,
			vetoedBy: ["rev-3"],
			awaiting: ["security"],
		});
	});

	it("counts only votes on the commit being merged: a new push needs new approval", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: "h0", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		await vote(log, { commit: "h0", reviewer: "rev-2", role: "api", verdict: "approve", evidence: "ok" });
		expect(approval((await log.read())!.commit.state, head, policy)).toMatchObject({ approved: false, approvals: 0 });
	});

	it("counts a reviewer once, by their latest verdict", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "still ok" });
		await vote(log, {
			commit: head,
			reviewer: "rev-2",
			role: "security",
			verdict: "reject",
			evidence: "leaks a token",
		});
		await vote(log, { commit: head, reviewer: "rev-2", role: "security", verdict: "approve", evidence: "fixed" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({
			approved: true,
			approvals: 2,
			vetoedBy: [],
			awaiting: [],
		});
	});
});

describe("votes count per verified identity, never the author's", () => {
	// No veto roles here: these are about whose approvals count.
	const policy = { required: 2, vetoes: [] as string[] };
	const cast = (
		reviewer: string,
		by: string | undefined,
		verdict: "approve" | "reject" = "approve",
		role = "tests",
	): VoteRecord => ({ commit: head, reviewer, role, verdict, evidence: "ok", at: "", ...(by ? { by } : {}) });

	it("counts one identity once, whatever names it votes under", () => {
		const votes = { votes: [cast("rev-1", "service:shared/agent-x"), cast("rev-2", "service:shared/agent-x")] };
		expect(approval(votes, head, policy)).toEqual({ approved: false, approvals: 1, vetoedBy: [], awaiting: [] });
	});

	it("counts distinct identities, as before", () => {
		const votes = { votes: [cast("rev-1", "service:shared/rev-1"), cast("rev-2", "service:githive-reviewer:tests")] };
		expect(approval(votes, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [], awaiting: [] });
	});

	it("doesn't count the author's own approval, by verified identity or, unsigned, by name", () => {
		const author = { agent: "agent-a", by: "service:shared/agent-a" };
		const votes = {
			votes: [
				cast("rev-1", "service:shared/agent-a"),
				cast("agent-a", undefined),
				cast("rev-2", "service:shared/rev-2"),
			],
		};
		expect(approval(votes, head, policy, author)).toEqual({
			approved: false,
			approvals: 1,
			vetoedBy: [],
			awaiting: [],
		});
	});

	it("takes a veto from whoever holds the role, the author included", () => {
		const policy = { required: 2, vetoes: ["security"], grants: { security: ["agent-a"] } };
		const author = { agent: "agent-a", by: "service:shared/agent-a" };
		const votes = {
			votes: [
				cast("rev-1", "service:shared/rev-1"),
				cast("rev-2", "service:shared/rev-2"),
				cast("agent-a", "service:shared/agent-a", "reject", "security"),
			],
		};
		expect(approval(votes, head, policy, author)).toMatchObject({ approved: false, vetoedBy: ["agent-a"] });
	});

	it("falls back to reviewer names when votes aren't signed", () => {
		const votes = { votes: [cast("rev-1", undefined), cast("rev-2", undefined)] };
		expect(approval(votes, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [], awaiting: [] });
	});
});

describe("a person and their agents count as one", () => {
	const policy = { required: 1, vetoes: [] as string[] };
	const cast = (
		reviewer: string,
		by: string,
		verdict: "approve" | "reject" = "approve",
		role = "tests",
	): VoteRecord => ({ commit: head, reviewer, role, verdict, evidence: "ok", at: "2026-10-10T00:00:00.000Z", by });
	const alice = "person:a11ce0000000";
	const bob = "person:b0b000000000";
	// A change by one of Alice's agents, signed in to GitHive.
	const author = { agent: "alice/a1", by: `${alice}/alice/a1` };

	it("so one person's agents can't approve each other's changes, but the person can", () => {
		const agents = [
			cast("alice/a2", `${alice}/alice/a2`),
			cast("alice/a3", `${alice}/alice/a3`),
			cast("a4", `${alice}/a4`),
		];
		expect(approval({ votes: agents }, head, policy, author)).toEqual({
			approved: false,
			approvals: 0,
			vetoedBy: [],
			awaiting: [],
		});
		// Alice herself may review her agent's work from the dashboard. Her vote and her agents' count once together.
		expect(approval({ votes: [...agents, cast("alice", alice)] }, head, policy, author)).toEqual({
			approved: true,
			approvals: 1,
			vetoedBy: [],
			awaiting: [],
		});
		// Someone else's approval counts too.
		expect(approval({ votes: [...agents, cast("bob/b1", `${bob}/bob/b1`)] }, head, policy, author)).toMatchObject({
			approved: true,
			approvals: 1,
		});
	});

	it("and a person's own change (made as themselves) isn't theirs to approve", () => {
		expect(approval({ votes: [cast("alice", alice)] }, head, policy, { agent: "alice", by: alice })).toMatchObject({
			approved: false,
			approvals: 0,
		});
	});

	it("and another person's agents approve once between them", () => {
		const votes = { votes: [cast("bob/b1", `${bob}/bob/b1`), cast("bob/b2", `${bob}/bob/b2`), cast("bob", bob)] };
		expect(approval(votes, head, { required: 2, vetoes: [] }, author)).toMatchObject({ approved: false, approvals: 1 });
	});

	it("so a role granted to people (as every veto role is by default) is signed off by a person, never an agent", () => {
		const security = { required: 1, vetoes: ["security"] };
		expect(holdsRole(security, "security", { reviewer: "bob", by: bob })).toBe(true);
		expect(holdsRole(security, "security", { reviewer: "bob/b1", by: `${bob}/bob/b1` })).toBe(false);
		expect(holdsRole(security, "security", { reviewer: "b2", by: `${bob}/b2` })).toBe(false);
		const votes = { votes: [cast("bob/b1", `${bob}/bob/b1`), cast("bob/b2", `${bob}/bob/b2`, "approve", "security")] };
		expect(approval(votes, head, security, author)).toMatchObject({
			approved: false,
			awaiting: ["security"],
			ungranted: ["bob/b2 (security)"],
		});
	});

	it("and only a person answers what an agent put to people (ask_human)", () => {
		const flag = { change: "c", agent: "alice/a1", reason: "a trade-off", at: "2026-10-09T00:00:00.000Z" };
		const state = (by: string) => ({ votes: [cast("x", by)], flags: [flag] }) as unknown as Votes;
		expect(openFlag(state(`${bob}/bob/b1`), "c", head)).not.toBeNull();
		expect(openFlag(state(bob), "c", head)).toBeNull();
	});

	it("and a pool of one person's agents isn't people, for the warnings", () => {
		expect(grantWarnings({ required: 1, vetoes: ["security"], grants: { security: [`${bob}/*`] } })).toContainEqual(
			expect.stringContaining("no person holds security"),
		);
		expect(grantWarnings({ required: 1, vetoes: ["security"], grants: { security: [`${bob}/*`, bob] } })).toEqual([]);
	});
});

describe("policies", () => {
	const cast = (reviewer: string, role: string, verdict: "approve" | "reject" = "approve"): VoteRecord => ({
		commit: head,
		reviewer,
		role,
		verdict,
		evidence: "ok",
		at: "",
	});
	const policy = {
		required: 1,
		vetoes: [],
		escalate: [{ paths: ["package.json", ".github/"], required: 2, vetoes: ["security"] }],
		grants: { security: ["sec", "rev-2", "rev-3"] },
	};

	it("needs one approval for most changes, and security's too for dependency and CI files", () => {
		const one = { votes: [cast("rev-1", "review")] };
		expect(approval(one, head, policy, undefined, ["src/a.js"])).toMatchObject({ approved: true, approvals: 1 });
		expect(approval(one, head, policy, undefined, ["src/a.js", "package.json"])).toMatchObject({
			approved: false,
			awaiting: ["security"],
		});
		expect(effectivePolicy(policy, [".github/workflows/ci.yml"])).toEqual({ required: 2, vetoes: ["security"] });
		const both = { votes: [cast("rev-1", "review"), cast("rev-2", "security")] };
		expect(approval(both, head, policy, undefined, ["package.json"])).toMatchObject({ approved: true, approvals: 2 });
	});

	it("merges on the checks alone when no approval is required", () => {
		expect(approval({ votes: [] }, head, { required: 0, vetoes: [] })).toEqual({
			approved: true,
			approvals: 0,
			vetoedBy: [],
			awaiting: [],
		});
	});
});
