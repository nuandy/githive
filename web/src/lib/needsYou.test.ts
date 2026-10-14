import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { needsYou } from "./needsYou";
import { changeState } from "./status";

type Claim = RepoSnapshot["claims"][number];

const claim = (change: string, over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths: [`src/${change}/`],
	intent: change,
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: `${change}-head`,
	approval: { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] },
	...over,
});
const snapshot = (claims: Claim[], votes: RepoSnapshot["votes"] = []) => ({
	claims,
	votes,
	policy: { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } },
});

describe("what needs you in a repo", () => {
	it("is agents' questions, votes only people may give, and the audit's open violations", () => {
		const asks = claim("asks", { attention: { reason: "which cache size?", agent: "agent-asks", at: "" } });
		const votes = claim("votes");
		const result = needsYou(snapshot([votes, asks]), { open: 2 });
		expect(result.changes).toEqual([
			{ kind: "question", change: "asks", agent: "agent-asks", reason: "which cache size?", at: "" },
			{ kind: "vote", change: "votes", role: "security" },
		]);
		expect(result).toMatchObject({ violations: 2, count: 4 });
	});

	it("asks a person to look at a change Clef flags, after questions and before votes, without holding it up", () => {
		const flags = [{ in: "review evidence", by: "rev-1", likelihood: 0.95 }];
		const flagged = claim("flagged", { steering: flags });
		const asks = claim("asks", { attention: { reason: "which cache size?", agent: "agent-asks", at: "" } });
		const result = needsYou(snapshot([claim("votes"), flagged, asks]));
		expect(result.changes.map((each) => each.kind)).toEqual(["question", "steering", "vote"]);
		expect(result.changes[1]).toEqual({ kind: "steering", change: "flagged", flags });
		// A question is what the change waits on: the flag shows on its page.
		const both = claim("both", { steering: flags, attention: { reason: "?", agent: "a", at: "" } });
		expect(needsYou(snapshot([both])).changes.map((each) => each.kind)).toEqual(["question"]);
		// Its state stays as it was: it's in review, not waiting on a person.
		expect(changeState(claim("flagged", { steering: flags, approval: { ...flagged.approval, awaiting: [] } }))).toBe(
			"in-review",
		);
	});

	it("leaves out failed checks and changes sent back: they're their agents' to fix", () => {
		const failed = claim("failed");
		const rejected = claim("rejected");
		const reject = (commit: string, role: string) => ({
			commit,
			reviewer: role === "checks" ? "githive-checks" : "rev-1",
			role,
			verdict: "reject" as const,
			evidence: "",
			at: "",
		});
		const building = claim("building", { head: null });
		const result = needsYou(
			snapshot([failed, rejected, building], [reject("failed-head", "checks"), reject("rejected-head", "review")]),
		);
		expect(result).toEqual({ changes: [], violations: 0, count: 0 });
	});

	it("reads each change's own branch's policy: a branch rule may leave a role to people", () => {
		const onRelease = claim("release", { into: "release/2.0", approval: { ...claim("x").approval, awaiting: ["qa"] } });
		const onMain = claim("main", { approval: { ...claim("x").approval, awaiting: ["qa"] } });
		const result = needsYou({
			claims: [onRelease, onMain],
			votes: [],
			policy: { required: 1, vetoes: ["qa"], grants: { qa: ["qa-bot"] } },
			branch: "main",
			branchRules: [{ pattern: "release/*", policy: { grants: { qa: ["person:*"] } } }],
		});
		expect(result.changes).toEqual([{ kind: "vote", change: "release", role: "qa" }]);
	});

	it("leaves out a vote a team may give: its members' agents may give it", () => {
		const result = needsYou({
			claims: [claim("team")],
			votes: [],
			policy: { required: 1, vetoes: ["security"], grants: { security: ["@acme/security"] } },
		});
		expect(result.count).toBe(0);
	});
});
