import { describe, expect, it } from "vitest";
import { approval, vote, type VoteRecord, type Votes } from "../src/free/votes";
import { MemoryLog } from "./helpers/memory-log";

// Coordinator-free review: reviewers append verdicts on the exact commit they
// reviewed; a merging agent counts them itself, under the task's policy.

const policy = { required: 2, vetoes: ["security"] };
const head = "h1";

describe("votes, coordinator-free", () => {
	it("approves a commit with the required approvals and no veto", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "tests pass" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "api is fine" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [] });
	});

	it("blocks a merge on a veto, whatever the approvals", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: head, reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "ok" });
		await vote(log, { commit: head, reviewer: "rev-3", role: "security", verdict: "reject", evidence: "leaks a token" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({ approved: false, approvals: 2, vetoedBy: ["rev-3"] });
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
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "reject", evidence: "breaks the api" });
		await vote(log, { commit: head, reviewer: "rev-2", role: "api", verdict: "approve", evidence: "fixed" });
		expect(approval((await log.read())!.commit.state, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [] });
	});

});

describe("votes count per verified identity, never the author's", () => {
	const cast = (reviewer: string, by: string | undefined, verdict: "approve" | "reject" = "approve", role = "tests"): VoteRecord => ({ commit: head, reviewer, role, verdict, evidence: "ok", at: "", ...(by ? { by } : {}) });

	it("counts one identity once, whatever names it votes under", () => {
		const votes = { votes: [cast("rev-1", "service:shared/agent-x"), cast("rev-2", "service:shared/agent-x")] };
		expect(approval(votes, head, policy)).toEqual({ approved: false, approvals: 1, vetoedBy: [] });
	});

	it("counts distinct identities, as before", () => {
		const votes = { votes: [cast("rev-1", "service:shared/rev-1"), cast("rev-2", "service:blueprint-reviewer:tests")] };
		expect(approval(votes, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [] });
	});

	it("doesn't count the author's own approval, by verified identity or, unsigned, by name", () => {
		const author = { agent: "agent-a", by: "service:shared/agent-a" };
		const votes = { votes: [cast("rev-1", "service:shared/agent-a"), cast("agent-a", undefined), cast("rev-2", "service:shared/rev-2")] };
		expect(approval(votes, head, policy, author)).toEqual({ approved: false, approvals: 1, vetoedBy: [] });
	});

	it("still takes a veto from anyone, the author included", () => {
		const author = { agent: "agent-a", by: "service:shared/agent-a" };
		const votes = { votes: [cast("rev-1", "service:shared/rev-1"), cast("rev-2", "service:shared/rev-2"), cast("sec", "service:shared/agent-a", "reject", "security")] };
		expect(approval(votes, head, policy, author)).toMatchObject({ approved: false, vetoedBy: ["sec"] });
	});

	it("falls back to reviewer names when votes aren't signed", () => {
		const votes = { votes: [cast("rev-1", undefined), cast("rev-2", undefined)] };
		expect(approval(votes, head, policy)).toEqual({ approved: true, approvals: 2, vetoedBy: [] });
	});
});
